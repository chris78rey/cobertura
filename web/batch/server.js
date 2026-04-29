const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const REPO_DIR = path.join(__dirname, '..', '..');

const clients = [];

function broadcast(data) {
    clients.forEach(client => {
        client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    });
}

app.post('/api/query-records', (req, res) => {
    const { start_date, end_date, modo } = req.body;
    
    console.log('Query records:', { start_date, end_date, modo });
    
    const scriptPath = path.join(REPO_DIR, 'scripts', 'query_records.js');
    console.log('Script path:', scriptPath);
    
    const proc = spawn('node', [
        scriptPath,
        '--start-date=' + start_date,
        '--end-date=' + end_date,
        '--modo=' + modo
    ], { cwd: REPO_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    
    let output = '';
    let errOutput = '';
    
    proc.stdout.on('data', (data) => {
        output += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
        errOutput += data.toString();
    });
    
    proc.on('close', (code) => {
        console.log('Query finished:', code);
        console.log('stdout:', output.slice(0, 500));
        console.log('stderr:', errOutput.slice(0, 500));
        try {
            if (output.trim()) {
                const records = JSON.parse(output.trim());
                res.json({ success: true, records });
            } else {
                res.json({ success: false, error: errOutput || 'No output' });
            }
        } catch (e) {
            res.json({ success: false, error: e.message + ' | output: ' + output.slice(0, 200) + ' | stderr: ' + errOutput.slice(0, 200) });
        }
    });
    
    proc.on('error', (err) => {
        console.error('Spawn error:', err);
        res.json({ success: false, error: err.message });
    });
});

app.post('/api/process-batch', (req, res) => {
    const { start_date, end_date, modo, output_dir, limit = 100 } = req.body;
    
    console.log('Starting batch:', { start_date, end_date, modo, output_dir, limit });
    
    const proc = spawn('node', [
        path.join(REPO_DIR, 'scripts', 'batch_oracle.js'),
        '--start-date=' + start_date,
        '--end-date=' + end_date,
        '--modo=' + modo,
        '--limit=' + limit,
        '--output-dir=' + output_dir
    ], { cwd: REPO_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    
    proc.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        lines.forEach(line => {
            broadcast({ type: 'log', message: line });
        });
    });
    
    proc.stderr.on('data', (data) => {
        const message = data.toString().trim();
        if (message) {
            broadcast({ type: 'error', message });
        }
    });
    
    proc.on('close', (code) => {
        broadcast({ type: 'done', code });
    });
    
    res.json({ success: true });
});

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    
    const client = { id: Date.now(), res };
    clients.push(client);
    
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    
    req.on('close', () => {
        const idx = clients.findIndex(c => c.id === client.id);
        if (idx >= 0) clients.splice(idx, 1);
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Batch UI running at http://0.0.0.0:${PORT}`);
});
