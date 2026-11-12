/**
 * Entry point for an AWS Lambda *Web Function*: an HTTP server listening on AWS_LAMBDA_HTTP_ENDPOINT (host:port).
 * It adapts plain HTTP requests to the handler in messenger-webhook.ts.
 * Build: npx esbuild backend/server.ts --bundle --platform=node --target=node22 --outfile=lambda-dist/index.js
 * Local test: run the bundle with node; with no env var it listens on 0.0.0.0:3000.
 */
import { createServer } from 'node:http'
import { handler } from './messenger-webhook'

const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? '0.0.0.0:3000').split(':')

createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const out = await handler({
      requestContext: { http: { method: req.method ?? 'GET' } },
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v])),
      queryStringParameters: Object.fromEntries(url.searchParams),
      body: Buffer.concat(chunks).toString('utf8'), // raw body: needed for Meta's signature check
    })
    res.writeHead(out.statusCode, { 'Content-Type': 'text/plain' }).end(out.body)
  } catch (err) {
    console.error(err)
    res.writeHead(500).end('error')
  }
}).listen(Number(port), host)
