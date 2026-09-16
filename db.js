const { JSONFilePreset } = require('lowdb/node');
const { Redis } = require('@upstash/redis');

const DEFAULT_STATE = {
  debts: [],
  owners: {},           // keyed by ownerId (Telegram chatId number, OR "web_<uuid>" string)
  allowedUsers: [],
  accessRequests: [],
  webUsersByEmail: {},   // email -> ownerId
};
const STATE_KEY = 'v1:state';

let dbInstance = null;

async function getDb() {
  if (dbInstance) return dbInstance;
  if (process.env.UPSTASH_REDIS_REST_URL) {
    dbInstance = await createUpstashDb();
  } else {
    dbInstance = await createLocalFileDb();
  }
  return dbInstance;
}

async function createUpstashDb() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  let data;
  try {
    data = await redis.get(STATE_KEY);
  } catch (err) {
    console.error('❌ Upstash Redis read failed:', err.message);
    throw err;
  }

  if (!data) {
    data = { ...DEFAULT_STATE };
    await redis.set(STATE_KEY, data);
  }
  for (const key of Object.keys(DEFAULT_STATE)) {
    if (data[key] === undefined) {
      data[key] = Array.isArray(DEFAULT_STATE[key]) ? [] : {};
    }
  }

  return {
    data,
    async write() {
      await redis.set(STATE_KEY, this.data);
    },
  };
}

async function createLocalFileDb() {
  const local = await JSONFilePreset('db.json', DEFAULT_STATE);
  let changed = false;
  for (const key of Object.keys(DEFAULT_STATE)) {
    if (local.data[key] === undefined) {
      local.data[key] = Array.isArray(DEFAULT_STATE[key]) ? [] : {};
      changed = true;
    }
  }
  if (changed) await local.write();
  return local;
}

module.exports = { getDb };