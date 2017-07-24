const mongoose = require('mongoose')

const Record = mongoose.model('ConsolidatedRecord')

async function handleIncomingWebHook({ data: { linkId } }) {
  const relatedRecordIds = await Record
    .distinct('recordId', { 'links.ids': linkId })
    .exec()

  const updatingRecords = relatedRecordIds
    .map(id => Record.triggerUpdated(id, 'link checked'))

  await Promise.all(updatingRecords)
}

exports.handler = handleIncomingWebHook