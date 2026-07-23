const { JSONFilePreset } = require('lowdb/node');

let dbInstance = null;

async function getDb() {
  if (!dbInstance) {
    dbInstance = await JSONFilePreset('db.json', { debts: [] });
  }
  return dbInstance;
}

module.exports = { getDb };