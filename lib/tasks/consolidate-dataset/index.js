const mongoose = require('mongoose');
const { uniq, compact } = require('lodash');
const distributions = require('./distributions');
const featureTypeResolve = require('./resolvers/featureType').resolve;
const computeFacets = require('../../helpers/facets').compute;
const Promise = require('bluebird');
const convertDataset = require('../../helpers/convertDataset');
const redlock = require('../../redlock');

const RecordRevision = mongoose.model('RecordRevision');
const CatalogRecord = mongoose.model('CatalogRecord');
const ConsolidatedRecord = mongoose.model('ConsolidatedRecord');
const RelatedResource = mongoose.model('RelatedResource');
const Publication = mongoose.model('Publication');


function clearLock(lock, err) {
  return lock.unlock().then(() => { if (err) throw err; });
}

function getConsolidationLock(recordId) {
  return redlock.lock(`geogw:${recordId}:consolidation`, 10000);
}

function getCatalogRecords(recordId) {
    return CatalogRecord
        .find({ recordId })
        .sort('-revisionDate -touchedAt')
        .populate('catalog', 'name')
        .lean()
        .exec();
}

function getBestRecordRevision(catalogRecords, record) {
    const { recordId, recordHash } = catalogRecords.length > 0 ? catalogRecords[0] : record;
    return RecordRevision.findOne({ recordId, recordHash }).exec()
        .then(recordRevision => {
            if (!recordRevision) throw new Error('Record revision not found for: ' + recordRevision.toJSON());
            return recordRevision;
        });
}

function fetchRelatedResources(recordId) {
    return RelatedResource.find({ record: recordId }).exec();
}

function getConsolidatedRecord(recordId) {
    return ConsolidatedRecord.findOne({ recordId }).exec()
        .then(record => {
            return record || new ConsolidatedRecord({ recordId });
        });
}

function fetchPublications(datasetId) {
    return Publication.find({ recordId: datasetId }).exec();
}

function createDatasetFromRecord(recordRevision) {
    if (recordRevision.recordType === 'Record') {
        return convertDataset.fromDublinCore(recordRevision.content);
    }
    if (recordRevision.recordType === 'MD_Metadata') {
        return convertDataset.fromIso(recordRevision.content);
    }
    throw new Error('Not supported record type: ' + recordRevision.recordType);
}

function applyRecordRevisionChanges(record, recordRevision) {
    // if (record.recordHash && record.recordHash === recordRevision.recordHash) return Promise.resolve(record);
    record
        .set('recordHash', recordRevision.recordHash)
        .set('revisionDate', recordRevision.revisionDate)
        .set('metadata', createDatasetFromRecord(recordRevision));

    return Promise.resolve(record);
}

function applyOrganizationsFilter(record) {
    const organizations = uniq(record.metadata.contacts.map(contact => contact.organizationName));
    return record.set('organizations', organizations);
}

function applyResources(record, relatedResources) {
    const distPromises = [];
    const alt = [];

    relatedResources.forEach(function (resource) {
        if (resource.originType === 'gmd:onLine' && resource.originHash !== record.recordHash) {
          // Ignore remote resources from other revisions
          return;
        }
        if (resource.type === 'feature-type') {
            distPromises.push(featureTypeResolve(resource));
        } else if (resource.type === 'remote-resource' && ['file-distribution', 'unknown-archive'].includes(resource.remoteResource.type)) {
            const layers = distributions.buildLayers(resource);
            if (layers) {
                Array.prototype.push.apply(distPromises, layers);
            } else {
                distPromises.push(distributions.buildOriginalDistribution(resource));
            }
        } else {
            alt.push({
                name: resource.name,
                location: resource.remoteResource.location,
                available: resource.remoteResource.available
            });
        }
    });

    return Promise.all(distPromises).then(dist => {
      return record
        .set('dataset.distributions', uniq(compact(dist), 'uniqueId'))
        .set('alternateResources', uniq(alt, 'location'));
    });
}

function exec(job, done) {
    const { recordId, freshness } = job.data;

    return getConsolidatedRecord(recordId).then(record => {
      if (record.isFresh(freshness)) {
        job.log('Record is fresh enough. Abording...');
        return;
      } else {
        return getConsolidationLock(recordId)
            .then(lock => {
                return getCatalogRecords(recordId)
                    .then(catalogRecords => {
                        return Promise.join(
                            fetchRelatedResources(recordId),
                            getBestRecordRevision(catalogRecords, record),
                            fetchPublications(recordId),

                            (relatedResources, recordRevision, publications) => {
                                return Promise.try(() => applyRecordRevisionChanges(record, recordRevision))
                                    .then(() => applyOrganizationsFilter(record))
                                    .then(() => applyResources(record, relatedResources))
                                    .then(() => {
                                        return record
                                            .set('catalogs', catalogRecords.map(catalogRecord => catalogRecord.catalog._id))
                                            .set('facets', computeFacets(record, {
                                              catalogs: catalogRecords.map(catalogRecord => catalogRecord.catalog),
                                              publications
                                            }))
                                            .save();
                                    })
                                    .then(() => clearLock(lock))
                                    .thenReturn();
                            }
                        );
                    })
                    .catch(err => clearLock(lock, err));
            });
      }
    }).asCallback(done);
}

exports.exec = exec;
exports.applyResources = applyResources;
exports.applyOrganizationsFilter = applyOrganizationsFilter;
exports.applyRecordRevisionChanges = applyRecordRevisionChanges;
exports.getConsolidatedRecord = getConsolidatedRecord;
exports.fetchRelatedResources = fetchRelatedResources;
exports.getCatalogRecords = getCatalogRecords;
exports.getBestRecordRevision = getBestRecordRevision;
