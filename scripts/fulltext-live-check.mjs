// Live check for full-text coverage. Run `npm run build` first, then
// `node scripts/fulltext-live-check.mjs` with a valid cached EZproxy session.
// One call per item, no retries. Prints one summary line each; never prints
// cookie values or article text.
import { getFullText } from '../dist/fullText.js';
import { searchOneSearch } from '../dist/primoClient.js';

const DOIS = [
  ['springer', '10.1007/s42979-024-03476-y'],
  ['springer', '10.1007/s10462-024-10827-x'],
  ['ieee', '10.1109/TII.2018.2822680'],
  ['ieee', '10.1109/TASE.2021.3073396'],
  ['mdpi', '10.3390/cryptography7020030'],
  ['mdpi', '10.3390/electronics13071391'],
  ['elsevier', '10.1016/j.cose.2025.104509'],
  ['elsevier', '10.1016/j.neucom.2023.127068'],
  ['acm', '10.1145/3453155'],
  ['acm', '10.1145/3582571'],
  ['wiley', '10.1002/ett.4150'],
  ['nature(regression)', '10.1038/nature14539'],
  ['plos(regression)', '10.1371/journal.pone.0212767'],
];

function host(url) {
  if (!url) return '-';
  try {
    return new URL(url).host;
  } catch {
    return '-';
  }
}

function line(label, r) {
  const msg = String(r.message ?? '').replace(/\s+/g, ' ').slice(0, 80);
  return [
    label,
    `status=${r.status}`,
    `fullText=${r.fullText}`,
    `textKind=${r.textKind ?? '-'}`,
    `version=${r.version ?? '-'}`,
    `chars=${r.charCount}`,
    `readUrl=${host(r.readUrl)}`,
    `msg=${msg}`,
  ].join(' | ');
}

async function run(label, input) {
  try {
    console.log(line(label, await getFullText(input)));
    return true;
  } catch (err) {
    console.log(`${label} | THROWN | ${String(err?.message ?? err).slice(0, 80)}`);
    return true;
  }
}

let first = true;
for (const [pub, doi] of DOIS) {
  const result = await getFullText({ doi }).catch((err) => ({
    status: 'THROWN', fullText: false, textKind: null, version: null, charCount: 0, readUrl: null, message: String(err?.message ?? err),
  }));
  console.log(line(`${pub} ${doi}`, result));
  if (first && result.status === 'login_required') {
    console.log('STOP: session expired. Re-run neu-onesearch-login.');
    process.exit(2);
  }
  first = false;
}

await run('#12 cdi_crossref_primary_10_34028_iajit_19_2_8', { recordId: 'cdi_crossref_primary_10_34028_iajit_19_2_8' });

try {
  const res = await searchOneSearch({
      query: 'runtime monitoring cyber-physical systems anomaly detection',
      peerReviewedOnly: true,
      dateFrom: 2020,
      limit: 3,
  });
  const year = (d) => {
    const pnx = d.pnx ?? {};
    const raw = pnx.addata?.date?.[0] ?? pnx.addata?.risdate?.[0] ?? pnx.display?.creationdate?.[0] ?? pnx.sort?.creationdate?.[0] ?? '';
    return String(raw).match(/\d{4}/)?.[0] ?? '-';
  };
  console.log(`#11 search | total=${res.info?.total ?? 0} | years=${(res.docs ?? []).slice(0, 3).map(year).join(',')}`);
} catch (err) {
  console.log(`#11 search | THROWN | ${String(err?.message ?? err).slice(0, 80)}`);
}
