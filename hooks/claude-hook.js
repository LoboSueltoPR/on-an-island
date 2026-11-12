// Hook de Claude Code: le pasa el evento a Isla por un puerto local.
// Si Isla no está abierta, sale sin hacer nada (nunca frena a Claude).
const http = require('http');

let data = '';
const done = () => process.exit(0);
setTimeout(done, 1500);
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const req = http.request(
    { host: '127.0.0.1', port: 47823, path: '/claude', method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 800 },
    (res) => { res.resume(); res.on('end', done); },
  );
  req.on('error', done);
  req.on('timeout', () => { req.destroy(); done(); });
  req.end(data);
});
