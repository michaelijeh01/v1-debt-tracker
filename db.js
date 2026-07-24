const { JSONFilePreset } = require('lowdb/node');
const { MongoClient } = require('mongodb');

const DEFAULT_STATE = { debts: [], owners: {}, allowedUsers: [], accessRequests: [] };

let dbInstance = null;

// If MONGODB_URI is set (on Render, in production), we use a real database
// that lives outside Render entirely — so it survives every redeploy.
// If it's NOT set (on your PC, for local testing), we fall back to the
// simple local db.json file like before, so local testing needs no setup.
async function getDb() {
  if (dbInstance) return dbInstance;

  if (process.env.MONGODB_URI) {
    dbInstance = await createMongoDb();
  } else {
    dbInstance = await createLocalFileDb();
  }
  return dbInstance;
}

async function createMongoDb() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const collection = client.db('v1tracker').collection('appState');

  // Everything lives in a single document, same shape as the old JSON file.
  let doc = await collection.findOne({ _id: 'singleton' });
  if (!doc) {
    doc = { _id: 'singleton', ...DEFAULT_STATE };
    await collection.insertOne(doc);
  }
  // Fill in any fields older data might be missing (safe migration)
  for (const key of Object.keys(DEFAULT_STATE)) {
    if (doc[key] === undefined) doc[key] = DEFAULT_STATE[key];
  }

  const { _id, ...data } = doc;

  return {
    data,
    async write() {
      await collection.updateOne(
        { _id: 'singleton' },
        { $set: this.data },
        { upsert: true }
      );
    },
  };
}

async function createLocalFileDb() {
  const local = await JSONFilePreset('db.json', DEFAULT_STATE);
  // Safe migration for local files created before some fields existed
  let changed = false;
  for (const key of Object.keys(DEFAULT_STATE)) {
    if (local.data[key] === undefined) {
      local.data[key] = DEFAULT_STATE[key];
      changed = true;
    }
  }
  if (changed) await local.write();
  return local;
}

module.exports = { getDb };