const { JSONFilePreset } = require('lowdb/node');

// Both the Telegram bot and the web dashboard import THIS file,
// so they're always reading and writing the exact same data —
// no syncing needed between two separate databases.
let dbInstance = null;

async function getDb() {
  if (!dbInstance) {
    dbInstance = await JSONFilePreset('db.json', { debts: [], owners: {} });
    // If db.json already existed from before this feature, it won't have
    // "owners" yet — add it safely so nothing crashes.
    if (!dbInstance.data.owners) {
      dbInstance.data.owners = {};
      await dbInstance.write();
    }
  }
  return dbInstance;
}

module.exports = { getDb };