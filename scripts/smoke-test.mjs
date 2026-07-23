import { searchOneSearch, getRecord } from '../dist/primoClient.js';

async function main() {
  console.log('Searching OneSearch for "machine learning"...');
  const searchResult = await searchOneSearch({ query: 'machine learning', limit: 3 });
  console.log(`Total results: ${searchResult.info.total}`);
  const firstDoc = searchResult.docs[0];
  console.log(`First doc title: ${firstDoc?.pnx.display?.title?.[0]}`);

  const recordId = firstDoc?.pnx.control?.recordid?.[0];
  if (recordId && recordId.startsWith('alma')) {
    console.log(`Fetching full record for ${recordId}...`);
    const record = await getRecord(recordId);
    console.log(`Record availability: ${record?.delivery?.displayedAvailability}`);
  } else {
    console.log('First result is not an NEU catalog record; skipping get_record check.');
  }

  console.log('Smoke test passed.');
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exitCode = 1;
});
