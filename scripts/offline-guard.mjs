// Preloaded by the test runner before application modules are imported.
// Ignore local credentials and fail immediately on accidental network access.
import dotenv from 'dotenv';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

dotenv.config = () => ({ parsed: {} });
const blocked = () => { throw new Error('Network access is disabled in offline tests'); };
globalThis.fetch = blocked;
net.connect = blocked;
net.createConnection = blocked;
net.Socket.prototype.connect = blocked;
tls.connect = blocked;
http.request = blocked;
http.get = blocked;
https.request = blocked;
https.get = blocked;
syncBuiltinESMExports();
