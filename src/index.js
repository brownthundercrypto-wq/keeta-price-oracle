// Price-oracle anchor entrypoint. TESTNET ONLY.
import { NETWORK, PORT, PUBLISH_INTERVAL_MS } from './config.js';
import { pollOnce, startPolling, getCache } from './priceFeed.js';
import { initOracle, publishSnapshot, publishDiscovery } from './keetaOracle.js';
import { createServer } from './server.js';

function hardFailIfNotTest() {
  if (NETWORK !== 'test') {
    console.error(`[oracle] FATAL: network is '${NETWORK}', but this oracle is TESTNET ONLY. Exiting.`);
    process.exit(1);
  }
}

async function publishSnapshotSafe() {
  try {
    const { prices } = getCache();
    if (!Object.keys(prices).length) {
      console.warn('[oracle] no cached prices yet; skipping snapshot');
      return;
    }
    const { blockHash, previous } = await publishSnapshot(prices);
    console.log(`[oracle] snapshot SET_INFO block: ${blockHash} (previous: ${previous})`);
  } catch (e) {
    console.error('[oracle] snapshot publish failed:', e.message);
  }
}

async function main() {
  hardFailIfNotTest();

  const { address } = await initOracle();
  console.log(`[oracle] identity: ${address}`);
  console.log(`[oracle] network: test (hard-fail on any other network)`);

  // Warm the cache before serving / publishing.
  await pollOnce();
  console.log(`[oracle] initial prices: ${Object.keys(getCache().prices).join(', ')}`);
  startPolling();

  // Discovery metadata (second SET_INFO, services.oracle) once at startup.
  try {
    const { blockHash: dHash, previous: dPrev } = await publishDiscovery();
    console.log(`[oracle] discovery SET_INFO block: ${dHash} (previous: ${dPrev})`);
  } catch (e) {
    console.error('[oracle] discovery publish failed:', e.message);
  }

  // First snapshot now, then every 5 minutes.
  await publishSnapshotSafe();
  setInterval(publishSnapshotSafe, PUBLISH_INTERVAL_MS);

  const app = createServer();
  app.listen(PORT, () => console.log(`[oracle] HTTP listening on http://localhost:${PORT}`));
}

main().catch((e) => {
  console.error('[oracle] FATAL:', e.message);
  process.exit(1);
});
