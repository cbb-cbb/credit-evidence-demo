import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const allowed = new Set(['index.html','style.css','app.mjs','views.mjs','engine.mjs','data-import.mjs','report.mjs','README.md','EXPLORATION.md','PROVENANCE.md','METHODS.md','DATA_FORMAT.md','examples/valid-channel.csv','examples/invalid-quality.csv','examples/missing-days.csv']);
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.md':'text/plain; charset=utf-8','.csv':'text/csv; charset=utf-8'};
const port=Number(process.env.PORT || 5174);
const server=createServer(async(request,response)=>{
  let file;
  try{file=decodeURIComponent(new URL(request.url,'http://localhost').pathname).replace(/^\//,'')||'index.html';}catch{response.writeHead(400);response.end('Bad request');return;}
  if(!allowed.has(file)){response.writeHead(404);response.end('Not found');return;}
  try{
    const body=await readFile(fileURLToPath(new URL(file,import.meta.url)));
    response.writeHead(200,{'Content-Type':types[file.slice(file.lastIndexOf('.'))]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    response.end(body);
  }catch{response.writeHead(404);response.end('Not found');}
});
server.listen(port,'127.0.0.1',()=>console.log(`Evidence demo: http://127.0.0.1:${port}/`));
