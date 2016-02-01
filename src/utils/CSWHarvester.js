const EventEmitter = require('events').EventEmitter;
const MultiStream = require('multistream');
const through = require('through2').obj;
const csw = require('csw-client');
const _ = require('lodash');
const stringify = require('json-stable-stringify');
const debug = require('debug')('geogw:csw-harvester');
const sha1 = require('../helpers/hash').sha1;

class Harvester extends EventEmitter {

    constructor(location, options) {
        if (!location) throw new Error('location param is required');
        options = options || {};

        super();

        this.matched = 0;
        this.started = 0;
        this.ignored = 0;
        this.returned = 0;
        this.unique = 0;

        const client = csw(location, {
            userAgent: 'InspireBot',
            concurrency: 5,
            encodeQs: options.encodeQs
        });

        debug('new harvester for location: %s', location);

        client.on('request', req => debug('request %s', req.url.href));

        const harvestOptions = {};

        if (options.forceConstraintLanguage) {
            harvestOptions.constraintLanguage = 'CQL_TEXT';
        }

        if (options.defineNamespace) {
            harvestOptions.namespace = 'xmlns(gmd=http://www.isotc211.org/2005/gmd)';
        }

        const internalHarvesters = [];

        const started = _.once(() => {
            this.emit('started');
        });

        const addHarvester = (harvester, name) => {
            harvester
                .once('started', () => {
                    this.started++;
                    this.matched += harvester.matched;
                    this.emit('internal-harvester:started', { name, matched: harvester.matched });
                    debug('started harvester %s', name);
                    started();
                    if (this.started === internalHarvesters.length) {
                        this.allStarted = true;
                        this.emit('all-started');
                    }
                });
            internalHarvesters.push(harvester);
        };

        addHarvester(client.harvest(Object.assign({ schema: 'inspire' }, harvestOptions)), 'inspire');

        if (options.dublinCoreFallback) {
            addHarvester(client.harvest(harvestOptions), 'dublin-core');
        }

        const recordIds = new Set();

        this.innerStream = MultiStream(internalHarvesters, { objectMode: true }).pipe(through((record, enc, cb) => {
            const ignore = (reason) => {
                record.ignoreReason = reason;
                this.ignored++;
                this.emit('ignore', record);
                cb();
            };

            const supportedTypes = {
                MD_Metadata: { modifiedKey: 'dateStamp', idKey: 'fileIdentifier' },
                Record: { modifiedKey: 'modified', idKey: 'identifier' }
            };

            if (!(record.type in supportedTypes)) return ignore('Not supported type');

            const typeOptions = supportedTypes[record.type];

            record.id = record.body[typeOptions.idKey];

            // Technical checks
            if (!record.id) return ignore('No identifier');
            if (record.id.length < 10) return ignore('Identifier too short');
            if (record.id.length > 255) return ignore('Identifier too long');
            if (recordIds.has(record.id)) return ignore('Record already seen');

            // Augment record meta
            record.hashedId = sha1(record.id);
            record.hash = sha1(stringify(_.omit(record.body, typeOptions.modifiedKey)));
            if (_.isDate(record.body[typeOptions.modifiedKey])) {
                record.modified = record.body[typeOptions.modifiedKey];
            }

            recordIds.add(record.id);
            this.unique++;
            cb(null, record);
        }));

        this.innerStream.on('end', () => recordIds.clear());
    }

    pipe(target) {
        return this.innerStream.pipe(target);
    }

    unpipe(target) {
        return this.innerStream.unpipe(target);
    }

}

exports.Harvester = Harvester;
