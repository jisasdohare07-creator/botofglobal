const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { launchLoginWindow } = require('./instagram');
const cors = require('cors');

function startServer(sharedContext, botEngine) {
    const app = express();
    const PORT = process.env.PORT || 3000;

    app.use(cors());
    app.use(express.json());
    // Serve premium static dashboard panel from frontend directory
    app.use(express.static(path.join(__dirname, '..', 'frontend')));

    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server });

    const clients = new Set();

    wss.on('connection', (ws) => {
        clients.add(ws);
        
        const db = sharedContext.db;
        
        // Send initial configuration and rule state
        ws.send(JSON.stringify({
            type: 'init',
            payload: {
                settings: db.settings,
                autoReplies: db.autoReplies,
                stats: db.stats,
                loads: global.recentProcessedLoads || [],
                drivers: botEngine.loadDrivers(),
                todos: db.todoList || []
            }
        }));
        
        // Send active connection status
        ws.send(JSON.stringify({
            type: 'status',
            payload: {
                state: sharedContext.currentBotState,
                helper: sharedContext.currentBotHelper
            }
        }));
        
        // Send scanned QR code if offline
        if (sharedContext.latestQRCode && sharedContext.currentBotState === 'qr') {
            ws.send(JSON.stringify({
                type: 'qr',
                payload: sharedContext.latestQRCode
            }));
        }

        ws.on('close', () => {
            clients.delete(ws);
        });
    });

    function broadcastWS(type, payload) {
        const message = JSON.stringify({ type, payload });
        clients.forEach(wsClient => {
            if (wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(message);
            }
        });
    }

    function setBotState(state, helper) {
        sharedContext.currentBotState = state;
        sharedContext.currentBotHelper = helper;
        if (state === 'qr') {
            // Keep QR in context for fresh WS connections
            sharedContext.latestQRCode = helper;
        } else if (state === 'ready') {
            sharedContext.latestQRCode = null;
        }
        broadcastWS('status', { state, helper });
    }

    // Attach to sharedContext so that bot.js can broadcast log updates and status updates
    sharedContext.broadcastWS = broadcastWS;
    sharedContext.setBotState = setBotState;

    // --- Real-time Logs Interceptor ---
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    function formatLogMessage(args) {
        return args.map(arg => {
            if (typeof arg === 'object') {
                try { return JSON.stringify(arg); } catch (e) { return '[Object]'; }
            }
            return String(arg);
        }).join(' ');
    }

    console.log = (...args) => {
        originalLog.apply(console, args);
        const text = formatLogMessage(args);
        const time = new Date().toLocaleTimeString('en-US', { hour12: false });
        
        let level = 'info';
        if (text.includes('[✔]')) level = 'success';
        if (text.includes('[!]')) level = 'warning';
        if (text.includes('[❌]') || text.includes('[🚨]')) level = 'error';
        
        broadcastWS('log', { time, message: text, level });
    };

    console.error = (...args) => {
        originalError.apply(console, args);
        const text = formatLogMessage(args);
        const time = new Date().toLocaleTimeString('en-US', { hour12: false });
        broadcastWS('log', { time, message: `[ERROR] ${text}`, level: 'error' });
    };

    console.warn = (...args) => {
        originalWarn.apply(console, args);
        const text = formatLogMessage(args);
        const time = new Date().toLocaleTimeString('en-US', { hour12: false });
        broadcastWS('log', { time, message: `[WARN] ${text}`, level: 'warning' });
    };

    // --- Web API Controller Endpoints ---
    app.get('/api/state', (req, res) => {
        res.json({
            settings: sharedContext.db.settings,
            autoReplies: sharedContext.db.autoReplies,
            stats: sharedContext.db.stats
        });
    });

    // QR Code HTTP endpoint — so dashboard can poll without WebSocket
    app.get('/api/qr', (req, res) => {
        if (sharedContext.latestQRCode) {
            res.json({ qr: sharedContext.latestQRCode, status: 'pending' });
        } else if (sharedContext.currentBotState === 'ready') {
            res.json({ qr: null, status: 'connected' });
        } else {
            res.json({ qr: null, status: 'initializing' });
        }
    });

    app.post('/api/settings', (req, res) => {
        const { botName, ownerName, ownerNumber, prefix, aiModeEnabled, geminiApiKey, targetGroups, sourceChannels, ownerEmail, ownerCompany, excelPath, instagramEnabled, telegramEnabled, telegramToken, telegramChannelId } = req.body;
        
        if (!botName || !ownerName || !ownerNumber || !prefix) {
            return res.status(400).json({ error: 'Missing required configuration fields.' });
        }
        
        const db = sharedContext.db;
        db.settings.botName = botName;
        db.settings.ownerName = ownerName;
        db.settings.ownerNumber = ownerNumber.replace(/\D/g, ''); // Numeric only
        db.settings.prefix = prefix.trim().substring(0, 2);
        db.settings.aiModeEnabled = !!aiModeEnabled;
        db.settings.geminiApiKey = geminiApiKey || db.settings.geminiApiKey;
        if (Array.isArray(targetGroups)) db.settings.targetGroups = targetGroups;
        if (Array.isArray(sourceChannels)) db.settings.sourceChannels = sourceChannels;
        if (ownerEmail) db.settings.ownerEmail = ownerEmail.trim();
        if (ownerCompany) db.settings.ownerCompany = ownerCompany.trim();
        if (excelPath) db.settings.excelPath = excelPath.trim();
        db.settings.instagramEnabled = !!instagramEnabled;
        db.settings.telegramEnabled = !!telegramEnabled;
        if (telegramToken !== undefined) db.settings.telegramToken = telegramToken.trim();
        if (telegramChannelId !== undefined) db.settings.telegramChannelId = telegramChannelId.trim();
        
        sharedContext.saveDb(db);
        console.log(`[✔] Configurations updated successfully! Bot: "${botName}", Prefix: "${prefix}", Telegram: ${!!telegramEnabled}`);
        
        broadcastWS('init', {
            settings: db.settings,
            autoReplies: db.autoReplies,
            stats: db.stats,
            loads: global.recentProcessedLoads || [],
            drivers: botEngine.loadDrivers(),
            todos: db.todoList || []
        });
        
        res.json({ success: true, settings: db.settings });
    });

    // Expose Loads endpoint
    app.get('/api/loads', (req, res) => {
        res.json({ loads: global.recentProcessedLoads || [] });
    });

    // Manual Load Dispatcher Endpoint
    app.post('/api/loads/dispatch', async (req, res) => {
        const { channelName, text, isUrgent } = req.body;
        
        if (!text) {
            return res.status(400).json({ error: 'Load requirement text is required.' });
        }
        if (sharedContext.currentBotState !== 'ready' && sharedContext.currentBotState !== 'connected') {
            return res.status(400).json({ error: 'WhatsApp bot is offline. Please scan QR first!' });
        }
        
        console.log(`[+] Dashboard manual dispatch triggered for cargo load!`);
        try {
            // Trigger the async logistics process background worker in botEngine
            botEngine.processConfirmedLoad(
                channelName || 'Manual Dashboard Entry',
                null,
                null,
                text,
                text,
                !!isUrgent
            );
            res.json({ success: true, message: 'Cargo card rendering and system broadcasts successfully started!' });
        } catch (err) {
            console.error('[!] Dashboard load dispatch failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // Drivers Management Endpoints
    app.get('/api/drivers', (req, res) => {
        res.json({ drivers: botEngine.loadDrivers() });
    });

    app.post('/api/drivers', (req, res) => {
        const { name, phone, message } = req.body;
        
        if (!name || !phone || !message) {
            return res.status(400).json({ error: 'Driver name, WhatsApp number, and message are required.' });
        }
        
        try {
            const drivers = botEngine.loadDrivers();
            const newDriver = {
                id: Date.now().toString(),
                name: name.trim(),
                sender: phone.trim().replace(/\D/g, '') + '@c.us',
                message: message.trim()
            };
            drivers.push(newDriver);
            botEngine.saveDrivers(drivers);
            console.log(`[✔] Added driver from dashboard: ${name} (${phone})`);
            res.json({ success: true, drivers });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.delete('/api/drivers/:id', (req, res) => {
        const { id } = req.params;
        
        try {
            let drivers = botEngine.loadDrivers();
            const index = drivers.findIndex(d => d.id === id);
            if (index === -1) {
                return res.status(404).json({ error: 'Driver record not found.' });
            }
            
            const removed = drivers.splice(index, 1);
            botEngine.saveDrivers(drivers);
            console.log(`[!] Removed driver from dashboard list: ${removed[0].name}`);
            res.json({ success: true, drivers });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Todo List / Reminders Endpoints
    app.get('/api/todos', (req, res) => {
        res.json({ todoList: sharedContext.db.todoList || [], reminders: sharedContext.db.reminders || [] });
    });

    app.post('/api/todos', (req, res) => {
        const { text } = req.body;
        
        if (!text) {
            return res.status(400).json({ error: 'Task text is required.' });
        }
        
        const db = sharedContext.db;
        db.todoList = db.todoList || [];
        const newTodo = {
            id: Date.now().toString(),
            text: text.trim(),
            completed: false
        };
        db.todoList.push(newTodo);
        sharedContext.saveDb(db);
        res.json({ success: true, todoList: db.todoList });
    });

    app.delete('/api/todos/:id', (req, res) => {
        const { id } = req.params;
        
        const db = sharedContext.db;
        db.todoList = db.todoList || [];
        const index = db.todoList.findIndex(t => t.id === id);
        if (index === -1) {
            return res.status(404).json({ error: 'Todo item not found.' });
        }
        
        db.todoList.splice(index, 1);
        sharedContext.saveDb(db);
        res.json({ success: true, todoList: db.todoList });
    });

    // Check Instagram Authentication Status
    app.get('/api/instagram/status', (req, res) => {
        const sessionDir = path.join(__dirname, 'instagram_session');
        try {
            const exists = fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0;
            res.json({ loggedIn: exists });
        } catch(e) {
            res.json({ loggedIn: false });
        }
    });

    // Launch Instagram login window via Puppeteer (Visible Browser)
    app.post('/api/instagram/login', async (req, res) => {
        console.log('[i] Instagram login window launch triggered from dashboard...');
        try {
            // Send response first so UI doesn't hang, then launch browser
            res.json({ success: true, message: 'Instagram login window launching...' });
            await launchLoginWindow();
        } catch (err) {
            console.error('[!] Failed to launch Instagram login window:', err.message);
        }
    });

    // Purge Instagram Auth session files (Logout)
    app.post('/api/instagram/logout', (req, res) => {
        console.log('[!] Clearing Instagram session...');
        const sessionDir = path.join(__dirname, 'instagram_session');
        if (fs.existsSync(sessionDir)) {
            try {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                console.log('[✔] Instagram session folder successfully deleted.');
                res.json({ success: true });
            } catch (err) {
                console.error('[!] Failed to clear Instagram session:', err.message);
                res.status(500).json({ error: err.message });
            }
        } else {
            res.json({ success: true, message: 'Session already cleared.' });
        }
    });

    app.post('/api/broadcast', async (req, res) => {
        const { target, message } = req.body;
        const client = botEngine.getClient();
        
        if (sharedContext.currentBotState !== 'ready') {
            return res.status(400).json({ error: 'Bot is offline. Please scan QR and connect to WhatsApp first!' });
        }
        
        if (!message) {
            return res.status(400).json({ error: 'Broadcast message content cannot be empty.' });
        }
        
        console.log(`[i] Initiating broadcast request. Target: ${target}...`);
        
        try {
            const chats = await client.getChats();
            let targets = [];
            
            if (target === 'private') {
                targets = chats.filter(c => !c.isGroup);
            } else if (target === 'groups') {
                targets = chats.filter(c => c.isGroup);
            } else {
                targets = chats;
            }
            
            let sentCount = 0;
            const db = sharedContext.db;
            for (const chat of targets) {
                try {
                    await client.sendMessage(chat.id._serialized, message);
                    sentCount++;
                    db.stats.messagesSent++;
                    await new Promise(r => setTimeout(r, 1000));
                } catch (err) {
                    // Skip errors silently to proceed through broadcast target list
                }
            }
            
            sharedContext.saveDb(db);
            broadcastWS('stats', db.stats);
            console.log(`[✔] Message broadcast completed! Delivered to ${sentCount} active chats.`);
            res.json({ success: true, sentCount });
        } catch (err) {
            console.error('Fatal crash during broadcast operation:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/replies', (req, res) => {
        const { trigger, reply } = req.body;
        
        if (!trigger || !reply) {
            return res.status(400).json({ error: 'Keyword trigger and response message required.' });
        }
        
        const db = sharedContext.db;
        const cleanTrigger = trigger.trim().toLowerCase();
        const index = db.autoReplies.findIndex(r => r.trigger.toLowerCase() === cleanTrigger);
        if (index !== -1) {
            db.autoReplies[index].reply = reply.trim();
        } else {
            db.autoReplies.push({
                trigger: cleanTrigger,
                reply: reply.trim()
            });
        }
        
        sharedContext.saveDb(db);
        console.log(`[✔] Auto-reply rule configured: Trigger "${cleanTrigger}" -> "${reply}"`);
        res.json({ success: true, autoReplies: db.autoReplies });
    });

    app.delete('/api/replies/:trigger', (req, res) => {
        const trigger = decodeURIComponent(req.params.trigger).trim().toLowerCase();
        const db = sharedContext.db;
        const index = db.autoReplies.findIndex(r => r.trigger.toLowerCase() === trigger);
        
        if (index === -1) {
            return res.status(404).json({ error: 'Keyword trigger rule not found.' });
        }
        
        db.autoReplies.splice(index, 1);
        sharedContext.saveDb(db);
        console.log(`[!] Auto-reply rule deleted for trigger: "${trigger}"`);
        res.json({ success: true, autoReplies: db.autoReplies });
    });

    app.post('/api/logout', async (req, res) => {
        console.log('[!] Purging WhatsApp bot session and logging out...');
        const client = botEngine.getClient();
        try {
            if (client) {
                await client.logout();
                await client.destroy();
            }
        } catch (e) {
            // Ignore destroy failures
        }
        
        const sessionDir = path.join(__dirname, '..', '.wwebjs_auth');
        if (fs.existsSync(sessionDir)) {
            try {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                console.log('[✔] Session auth folder successfully deleted.');
            } catch (err) {
                console.error('[!] Failed to clear auth directory:', err.message);
            }
        }
        
        res.json({ success: true });
        setBotState('disconnected', 'Session cleared. Re-initializing server...');
        
        if (typeof sharedContext.reinitializeBot === 'function') {
            setTimeout(() => {
                sharedContext.reinitializeBot();
            }, 2000);
        }
    });

    // ==========================================
    // 🔵 ANALYTICS API ENDPOINT
    // ==========================================
    app.get('/api/analytics', (req, res) => {
        const db = sharedContext.db;
        const loads = global.recentProcessedLoads || [];
        const channelCounts = {};
        loads.forEach(l => {
            channelCounts[l.channel] = (channelCounts[l.channel] || 0) + 1;
        });
        const topChannels = Object.entries(channelCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([name, count]) => ({ name, count }));

        // Hourly load distribution (last 24 hours)
        const hourly = Array(24).fill(0);
        loads.forEach(l => {
            try {
                const h = new Date().getHours(); // approximate
                hourly[h]++;
            } catch(e) {}
        });

        res.json({
            totalLoads: loads.length,
            totalMessages: db.stats.messagesReceived,
            totalSent: db.stats.messagesSent,
            totalCommands: db.stats.commandsExecuted,
            topChannels,
            hourlyDistribution: hourly,
            monitoredChannels: (db.settings.sourceChannels || []).length,
            instagramEnabled: db.settings.instagramEnabled,
            telegramEnabled: db.settings.telegramEnabled
        });
    });

    server.listen(PORT, () => {
        console.log(`[✔] Glassmorphism Dashboard listening at http://localhost:${PORT}`);
    });

    return {
        server,
        broadcastWS
    };
}

module.exports = {
    startServer
};
