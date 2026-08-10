// Throwaway local receiver: the browser fetches CSV exports using the user's
// logged-in Google session and POSTs them here, so sheet data lands on disk
// without round-tripping through the model context.
import { createServer } from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = new URL('../data/raw/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (req.method !== 'POST') return res.writeHead(405).end('POST only');

  const name = (new URL(req.url, 'http://localhost').searchParams.get('name') || 'unnamed')
    .replace(/[^a-zA-Z0-9._-]/g, '_');

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    await writeFile(join(OUT, name), body);
    console.log(`received ${name}: ${body.length} bytes`);
    res.writeHead(200).end(`ok ${body.length}`);
  });
});

server.listen(3999, '127.0.0.1', () => console.log('receiver listening on 3999'));
