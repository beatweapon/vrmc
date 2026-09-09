import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../docs/', import.meta.url));
const types = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.vrm':'model/gltf-binary', '.png':'image/png', '.wasm':'application/wasm'};
export function serve(port = 8080) {
  const server = createServer(async (req, res) => {
    try {
      const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
      if (path !== resolve(root) && !path.startsWith(resolve(root) + sep)) { res.writeHead(403).end(); return; }
      const file = (await stat(path)).isDirectory() ? resolve(path, 'index.html') : path;
      const data = await readFile(file);
      res.writeHead(200, {'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store'}).end(data);
    } catch { res.writeHead(404).end('Not found'); }
  });
  return server.listen(port, '127.0.0.1');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  serve(port);
  console.log(`VRMC: http://localhost:${port}/fullbody/`);
}
