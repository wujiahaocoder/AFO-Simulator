'use strict';
// Explicitly started, loopback-only developer transport. The offline game never loads it.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function createDebugServer({ port = 0, root = __dirname } = {}) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be 0—65535');
    const token = crypto.randomBytes(24).toString('hex');
    const sessions = new Map(), jobs = new Map();
    let origin;
    const files = new Map([
        ['/', ['index.html', 'text/html; charset=utf-8']],
        ['/index.html', ['index.html', 'text/html; charset=utf-8']],
        ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
        ['/narrative.js', ['narrative.js', 'text/javascript; charset=utf-8']],
        ['/narrative-data.js', ['narrative-data.js', 'text/javascript; charset=utf-8']],
        ['/__debug__/bridge.js', ['debug-bridge.js', 'text/javascript; charset=utf-8']]
    ]);
    const send = (res, status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(value));
    };
    async function readJSON(req) {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
            size += chunk.length;
            if (size > 1024 * 1024) throw Object.assign(new Error('JSON exceeds 1 MiB'), { status: 413 });
            chunks.push(chunk);
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch (_) { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
    }
    const expire = () => {
        const now = Date.now();
        for (const [id, session] of sessions) if (now - session.lastSeen > 60000) sessions.delete(id);
        for (const [id, job] of jobs) {
            if (['queued', 'running'].includes(job.status) && now - job.created > 30000) {
                job.status = 'error'; job.error = 'Browser command timed out';
            }
            if (now - job.created > 300000) jobs.delete(id);
        }
    };
    const server = http.createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
        try {
            if (req.headers.host !== new URL(origin).host ||
                req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') {
                send(res, 403, { error: 'Only this loopback origin is allowed' }); return;
            }
            const url = new URL(req.url, origin), pathname = url.pathname;
            if (req.method === 'GET' && files.has(pathname)) {
                const [name, type] = files.get(pathname);
                let content = fs.readFileSync(path.join(root, name));
                if (name === 'index.html') {
                    const boot = `<script>window.AFODebugBoot=${JSON.stringify({ enabled: true, token })};</script>`;
                    content = Buffer.from(content.toString('utf8').replace('<head>', '<head>' + boot)
                        .replace('</body>', '<script src="/__debug__/bridge.js"></script></body>'));
                }
                res.writeHead(200, { 'Content-Type': type }); res.end(content); return;
            }
            if (!pathname.startsWith('/__debug__/')) { send(res, 404, { error: 'Not found' }); return; }
            if (req.headers.authorization !== 'Bearer ' + token) { send(res, 401, { error: 'Bearer token required' }); return; }
            expire();
            if (req.method === 'GET' && pathname === '/__debug__/sessions') {
                send(res, 200, { sessions: [...sessions.values()].map(({ id, lastSeen }) => ({ id, lastSeen })) }); return;
            }
            if (req.method === 'POST' && pathname === '/__debug__/sessions') {
                if (sessions.size >= 16) { send(res, 429, { error: 'Too many debug tabs' }); return; }
                const id = crypto.randomUUID(); sessions.set(id, { id, lastSeen: Date.now() });
                send(res, 201, { id }); return;
            }
            if (req.method === 'POST' && pathname === '/__debug__/command') {
                const body = await readJSON(req);
                if (!body || Array.isArray(body) || typeof body !== 'object') { send(res, 400, { error: 'Request must be an object' }); return; }
                const id = body.sessionId || (sessions.size === 1 ? [...sessions.keys()][0] : null);
                if (!sessions.has(id)) { send(res, 409, { error: 'Choose a connected browser sessionId' }); return; }
                if (!body.command || typeof body.command.op !== 'string') { send(res, 400, { error: 'command.op is required' }); return; }
                if ([...jobs.values()].filter(j => ['queued', 'running'].includes(j.status)).length >= 64) {
                    send(res, 429, { error: 'Too many pending commands' }); return;
                }
                const jobId = crypto.randomUUID();
                jobs.set(jobId, { id: jobId, sessionId: id, command: body.command, status: 'queued', created: Date.now() });
                send(res, 202, { jobId }); return;
            }
            const next = pathname.match(/^\/__debug__\/sessions\/([a-f0-9-]+)\/next$/);
            if (req.method === 'GET' && next) {
                const session = sessions.get(next[1]);
                if (!session) { send(res, 404, { error: 'Debug session expired' }); return; }
                session.lastSeen = Date.now();
                const job = [...jobs.values()].find(j => j.sessionId === session.id && j.status === 'queued');
                if (job) job.status = 'running';
                send(res, 200, job ? { jobId: job.id, command: job.command } : { jobId: null }); return;
            }
            const result = pathname.match(/^\/__debug__\/jobs\/([a-f0-9-]+)$/);
            if (result) {
                const job = jobs.get(result[1]);
                if (!job) { send(res, 404, { error: 'Unknown or expired job' }); return; }
                if (req.method === 'GET') {
                    send(res, 200, { jobId: job.id, status: job.status, result: job.result, error: job.error }); return;
                }
                if (req.method === 'POST') {
                    const body = await readJSON(req);
                    if (!body || Array.isArray(body) || typeof body !== 'object') { send(res, 400, { error: 'Result must be an object' }); return; }
                    if (body.sessionId !== job.sessionId || job.status !== 'running') {
                        send(res, 409, { error: 'Job is not running in this session' }); return;
                    }
                    job.status = body.ok ? 'done' : 'error'; job.result = body.result;
                    job.error = body.ok ? undefined : String(body.error || 'Browser command failed');
                    send(res, 200, { accepted: true }); return;
                }
            }
            send(res, 404, { error: 'Unknown debug endpoint' });
        } catch (error) { send(res, error.status || 500, { error: error.message }); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    origin = 'http://127.0.0.1:' + server.address().port;
    return { server, url: origin, token, close: () => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())) };
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length > 1 || args[0] && !/^--port=\d+$/.test(args[0])) {
        console.error('Usage: node debug-server.cjs [--port=8787]'); process.exitCode = 1;
    } else createDebugServer({ port: args[0] ? Number(args[0].slice(7)) : 8787 }).then(app => {
        console.log(JSON.stringify({ url: app.url, token: app.token, note: 'Open this URL in a browser; use the token for backend commands.' }));
        for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { createDebugServer };
