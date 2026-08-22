const CUSTOM_EPOCH = Date.UTC(2026, 0, 1);
const TIMESTAMP_BITS = 41n;
const NODE_ID_BITS = 10n;
const SEQUENCE_BITS = 12n;

const MAX_NODE_ID = (1n << NODE_ID_BITS) - 1n;
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n;
const NODE_ID_SHIFT = SEQUENCE_BITS;
const TIMESTAMP_SHIFT = NODE_ID_BITS + SEQUENCE_BITS;

const configuredNodeId = BigInt(process.env.SNOWFLAKE_NODE_ID || 1);

if (configuredNodeId < 0n || configuredNodeId > MAX_NODE_ID) {
  throw new Error(`SNOWFLAKE_NODE_ID must be between 0 and ${MAX_NODE_ID.toString()}`);
}

let lastTimestamp = 0n;
let sequence = 0n;

function timestampNow() {
  return BigInt(Date.now() - CUSTOM_EPOCH);
}

function waitForNextMillis(currentTimestamp) {
  let nextTimestamp = timestampNow();
  while (nextTimestamp <= currentTimestamp) {
    nextTimestamp = timestampNow();
  }
  return nextTimestamp;
}

function generateId() {
  let currentTimestamp = timestampNow();

  if (currentTimestamp < lastTimestamp) {
    throw new Error('System clock moved backwards; refusing to generate duplicate IDs');
  }

  if (currentTimestamp === lastTimestamp) {
    sequence = (sequence + 1n) & MAX_SEQUENCE;
    if (sequence === 0n) {
      currentTimestamp = waitForNextMillis(currentTimestamp);
    }
  } else {
    sequence = 0n;
  }

  lastTimestamp = currentTimestamp;

  return (currentTimestamp << TIMESTAMP_SHIFT) | (configuredNodeId << NODE_ID_SHIFT) | sequence;
}

function explainId(id) {
  const parsedId = typeof id === 'bigint' ? id : BigInt(id);
  const timestamp = Number(parsedId >> TIMESTAMP_SHIFT) + CUSTOM_EPOCH;
  const nodeId = Number((parsedId >> NODE_ID_SHIFT) & MAX_NODE_ID);
  const sequenceValue = Number(parsedId & MAX_SEQUENCE);

  return {
    id: parsedId.toString(),
    createdAt: new Date(timestamp).toISOString(),
    nodeId,
    sequence: sequenceValue,
  };
}

module.exports = {
  CUSTOM_EPOCH,
  explainId,
  generateId,
};
