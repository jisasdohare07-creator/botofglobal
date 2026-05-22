const { Client, RemoteAuth, LocalAuth } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const qrcode = require('qrcode-terminal');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { sendToInstagramGroup } = require('./instagram');

// Absolute path to Excel sheet on Desktop
const getExcelPath = (db) => db.settings.excelPath || 'C:\\Users\\Admin\\Desktop\\WhatsApp_Loads.xlsx';

let client;
let sharedContext = {}; // Will hold db, saveDb, broadcastWS, setBotState

// --- AI REFINEMENT CONFIGURATION ---
const GEMINI_API_KEYS = process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',') : [
    "AIzaSyD7BajJNHGfmBrhgxTjvrY2XLDQ8-jofHU",
    "AIzaSyBSl3kzKnofJcOY4QR_A7hGtj8cK2ed9ho",
    "AIzaSyDhS7HlYOsgH0Gyy3njl3-WB_UyHMKHgNY",
    "AIzaSyB1EQ-DfVpKlQ3rs1PZUgnwE500N8qkp5o",
    "AIzaSyCbnYZwhjKCd830MgcZJ18S7S7ASw5GKbs"
];
let currentKeyIndex = 0;

function getNextGeminiKey() {
    const key = GEMINI_API_KEYS[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % GEMINI_API_KEYS.length;
    return key;
}

async function refineLoadMessageWithAI(rawText, mediaData = null) {
    try {
        const key = getNextGeminiKey();
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${key}`;
        
        const prompt = `You are an expert logistics parser for GLOBALUNIDO. 
Read the following raw transport load message (or attached image/audio) and convert it into a highly professional, beautiful WhatsApp format.
CRITICAL RULES:
1. ONLY output the formatted message. NO introductory text, NO explanations, NO options.
2. Do NOT include the original sender's phone number. Remove any competitor names.
3. **Auto-Translation**: If the raw message is in Gujarati, Marathi, Bengali, or broken Hindi, translate the output seamlessly into Professional English/Hindi.
4. **Rate Rule**: ONLY include the expected rate/bhada IF it is explicitly mentioned in the raw message by the loader. DO NOT estimate or predict the rate yourself. If no rate is mentioned, DO NOT include the "Expected Market Rate" line at all.
5. **Weather & Route Alerts**: Add real-time logical weather/route alerts based on typical route conditions in India (e.g., [🌧️ Alert: Heavy rain on Khandala Ghat]) if applicable.
7. Output MUST use this EXACT structure:

🚚 *FRESH LOAD REQUIREMENT* 📦
━━━━━━━━━━━━━━━━━━━━━━
📍 *Route:* [From City] ➔ [To City]
🚛 *Vehicle:* [Vehicle Type/Tyres]
⚖️ *Material/Weight:* [Material / Weight]
📅 *Date:* [Date or "Immediate"]
💰 *Expected Market Rate:* [Only if explicitly mentioned in raw text]
*(Weather/Route alerts if any)*

Raw message text:
${rawText || "See attached media"}`;

        let parts = [{ text: prompt }];
        if (mediaData && mediaData.data) {
            parts.push({
                inlineData: {
                    mimeType: mediaData.mimetype,
                    data: mediaData.data
                }
            });
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: parts }],
                generationConfig: { temperature: 0.1 }
            })
        });

        const data = await response.json();
        if (data.candidates && data.candidates[0].content.parts[0].text) {
            return data.candidates[0].content.parts[0].text.trim();
        } else {
            console.error("[!] Invalid API response from Gemini:", JSON.stringify(data));
            throw new Error("Invalid API response format");
        }
    } catch (err) {
        console.error("[!] AI Refinement failed, falling back to basic formatting:", err.message);
        return null;
    }
}

async function verifyTruckPhotoWithAI(mediaData) {
    try {
        const key = getNextGeminiKey();
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${key}`;
        
        const prompt = `You are an expert logistics AI for GLOBALUNIDO.
The user has uploaded a photo to prove they have loaded a truck/vehicle for a transport job.
Your task is to verify if the photo actually contains a truck, a commercial vehicle, cargo being loaded, or a Lorry Receipt (Bilty).

Rules:
1. If the photo clearly shows a truck, commercial vehicle, loaded cargo, or a transport document (like Bilty), return exactly: "VALID_PROOF"
2. If the photo is a selfie, a meme, a blank picture, or completely unrelated to logistics/transport, return exactly: "INVALID_PROOF: [Provide a short reason in Hindi explaining what kind of photo they should send instead. E.g. Kripya gaadi ki photo, load hote hue maal ki photo, ya bilty ki photo bhejein.]"

DO NOT add any other explanation or text. Just follow the exact return formats above.`;

        let parts = [{ text: prompt }];
        if (mediaData && mediaData.data) {
            parts.push({
                inlineData: {
                    mimeType: mediaData.mimetype,
                    data: mediaData.data
                }
            });
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: parts }],
                generationConfig: { temperature: 0.1 }
            })
        });

        const data = await response.json();
        if (data.candidates && data.candidates[0].content.parts[0].text) {
            return data.candidates[0].content.parts[0].text.trim();
        } else {
            console.error("[!] Invalid API response from Gemini in Photo Verification:", JSON.stringify(data));
            return "VALID_PROOF"; 
        }
    } catch (err) {
        console.error("[!] Photo Verification AI failed:", err.message);
        return "VALID_PROOF"; 
    }
}

// --- 1. LOCAL DATA FILES RESOLUTION ---
const DRIVERS_FILE = path.join(__dirname, 'drivers.json');
const CONTACTS_FILE = path.join(__dirname, 'contacts.json');

function loadDrivers() {
    try {
        if (fs.existsSync(DRIVERS_FILE)) {
            return JSON.parse(fs.readFileSync(DRIVERS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('[!] Error loading drivers:', e.message);
    }
    return [];
}

function saveDrivers(drivers) {
    try {
        fs.writeFileSync(DRIVERS_FILE, JSON.stringify(drivers, null, 2), 'utf8');
    } catch (e) {
        console.error('[!] Error saving drivers:', e.message);
    }
}

function loadContacts() {
    try {
        if (fs.existsSync(CONTACTS_FILE)) {
            return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('[!] Error loading contacts:', e.message);
    }
    return {};
}

function saveContacts(contacts) {
    try {
        fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), 'utf8');
    } catch (e) {
        console.error('[!] Error saving contacts:', e.message);
    }
}

// --- KHATA (PAYMENT) SYSTEM ---
const KHATA_FILE = path.join(__dirname, 'khata.json');
function loadKhata() {
    try {
        if (fs.existsSync(KHATA_FILE)) {
            return JSON.parse(fs.readFileSync(KHATA_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('[!] Error loading khata:', e.message);
    }
    return {};
}

function saveKhata(khataData) {
    try {
        fs.writeFileSync(KHATA_FILE, JSON.stringify(khataData, null, 2), 'utf8');
    } catch (e) {
        console.error('[!] Error saving khata:', e.message);
    }
}

// Khata Reminder & Auto-POD Cron
let lastKhataDate = "";
setInterval(async () => {
    const now = new Date();
    const client = sharedContext && sharedContext.getClient ? sharedContext.getClient() : null;

    // Auto-POD (Check every minute)
    if (global.activeLoads && client) {
        for (const [loadId, data] of Object.entries(global.activeLoads)) {
            if (data.status === 'closed' && data.deliveryDeadline && now.getTime() > data.deliveryDeadline) {
                try {
                    const driverNum = data.lastAcceptedBy;
                    if (driverNum) {
                        const targetWID = driverNum.length === 10 ? '91' + driverNum + '@c.us' : driverNum + '@c.us';
                        const msg = `Sir, aapki gaadi (${data.route}) khali ho gayi kya? Kripya POD (Bilty) ki photo bhej dijiye. 🚚📸`;
                        await client.sendMessage(targetWID, msg);
                        console.log(`[+] Auto-POD reminder sent for load ${loadId} to ${driverNum}`);
                    }
                } catch (e) {
                    console.error("[!] Auto-POD reminder failed for " + loadId, e.message);
                }
                data.deliveryDeadline = null; // Mark as reminded
                data.status = 'completed';
                if (typeof broadcastActiveLoads === 'function') broadcastActiveLoads();
            }
        }
    }

    // 10:xx AM Khata Check
    if (now.getHours() === 10) {
        const todayStr = now.toDateString();
        if (lastKhataDate !== todayStr) {
            lastKhataDate = todayStr;
            const khata = loadKhata();
            if (client) {
                for (const [number, data] of Object.entries(khata)) {
                    if (data.pendingAmount > 0) {
                        try {
                            const targetWID = number.length === 10 ? '91' + number + '@c.us' : number + '@c.us';
                            const reasonText = data.reason ? ` (${data.reason})` : '';
                            const msg = `*GLOBALUNIDO Logistics* 🚚\n\nSir, aapka ₹${data.pendingAmount} ka balance pending hai${reasonText}. Kripya payment clear kar dein. 🙏`;
                            await client.sendMessage(targetWID, msg);
                            console.log(`[+] Sent khata reminder to ${number} for ₹${data.pendingAmount}`);
                        } catch (e) {
                            console.error("[!] Khata reminder failed for " + number, e.message);
                        }
                    }
                }
            }
        }
    }
}, 60000);

// Function to parse cities, weight, and vehicle from load text
function parseLoadText(text) {
    let fromPlace = "Anywhere";
    let toPlace = "Anywhere";
    let materialInfo = "Industrial Cargo";
    let vehicleInfo = "Any Truck Required";

    const lowerText = text.toLowerCase();

    // Parse Route (e.g. Latur to Mumbai or Latur se Pune or Latur - Mumbai)
    const routeRegex = /([a-zA-Z\u0900-\u097F\s]{3,20})\s+(?:to|se|-|👉|से)\s+([a-zA-Z\u0900-\u097F\s]{3,20})/i;
    const match = text.match(routeRegex);
    if (match) {
        fromPlace = match[1].trim();
        toPlace = match[2].trim();
    }

    // Parse Vehicle Type
    const vehicleKeywords = ['14 wheeler', '10 wheeler', '12 wheeler', 'open', 'container', 'trailer', 'lpt', 'tata ace', 'bolero', 'chota hathi', 'chhota hathi', 'tempo', 'eicher', 'hcv', 'lcv'];
    for (const kw of vehicleKeywords) {
        if (lowerText.includes(kw)) {
            vehicleInfo = kw.toUpperCase();
            break;
        }
    }

    // Parse Weight/Material Info
    const weightRegex = /(\d+(?:\.\d+)?\s*(?:ton|tons|mt|kg))/i;
    const weightMatch = text.match(weightRegex);
    if (weightMatch) {
        materialInfo = weightMatch[1].toUpperCase();
    }

    return { fromPlace, toPlace, materialInfo, vehicleInfo };
}

// Function to clean all competitor info from raw text before forwarding
function cleanMessageText(text) {
    if (!text) return "";
    
    let cleaned = text;
    const db = sharedContext.db;
    const ownerNumber = db.settings.ownerNumber || "8200210397";
    const ownerEmail = db.settings.ownerEmail || "supportglobalunido@gmail.com";
    const ownerCompany = db.settings.ownerCompany || "GLOBALUNIDO";

    // ── 1. Remove website URLs (http, https, www, wa.me) ──────────────────
    const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|(wa\.me\/[^\s]+)/gi;
    cleaned = cleaned.replace(urlRegex, '');

    // ── 2. Replace competitor phone numbers with owner's number ─────────────
    const phoneRegex = /(\+?\d{1,4}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
    cleaned = cleaned.replace(phoneRegex, (match) => {
        const digits = match.replace(/\D/g, '');
        if (digits.endsWith(ownerNumber.replace(/\D/g, ''))) {
            return match; // Keep our number as-is
        }
        return `+91 ${ownerNumber}`;
    });

    // ── 3. Replace competitor emails with owner's email ────────────────────
    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/g;
    cleaned = cleaned.replace(emailRegex, (match) => {
        if (match.toLowerCase() === ownerEmail.toLowerCase()) {
            return match;
        }
        return ownerEmail;
    });

    // ── 4. Remove/replace competitor company names & branding ──────────────
    // Remove lines that look like company signatures or branding headers
    // Pattern: standalone lines with company-type words (not load keywords)
    const companyLineRegex = /^[^\n]{0,60}(roadlines|roadways|logistics|transport(?:ers|ation|ing)?|carriers|movers|packers|pvt\.?\s*ltd\.?|private limited|cargo\s+service|freight\s+service|&\s*co\.?)\s*[:\-–—]?\s*$/gim;
    cleaned = cleaned.replace(companyLineRegex, '');

    // Replace competitor company name patterns inline (name + transport suffix)
    // We replace them with the owner's company name
    const inlineCompanyRegex = /\b([A-Z][a-zA-Z\s]{1,25})\s+(roadlines|roadways|transport(?:ers|ation)?|carriers|logistics|cargo|freight|movers)\b/gi;
    cleaned = cleaned.replace(inlineCompanyRegex, (match) => {
        // If it already contains our company name, keep it
        if (match.toLowerCase().includes('globalunido')) return match;
        return ownerCompany;
    });

    // ── 5. Remove office timing / working hours lines ──────────────────────
    // e.g. "9am to 6pm", "08:00 - 18:00", "subah 9 se shaam 6", "24/7 available"
    const timingRegex = /\b(timing|time|samay|office\s*hours?|working\s*hours?|available)[:\s–\-]*[\d\s:apmAMPM\-–to\/तक से बजे]+\b/gi;
    cleaned = cleaned.replace(timingRegex, '');

    // Remove standalone time ranges like "9AM-6PM", "8:00-17:00", "9 to 5", "9 baje se 6 baje"
    const timeRangeRegex = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM|बजे)?\s*[-–to से]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM|बजे)\b/gi;
    cleaned = cleaned.replace(timeRangeRegex, '');

    // Remove "24/7", "24x7", "round the clock" type phrases
    const alwaysOpenRegex = /\b(24\s*[\/x×]\s*7|round\s+the\s+clock|har\s+waqt|hamesha\s+available|24\s+ghante)\b/gi;
    cleaned = cleaned.replace(alwaysOpenRegex, '');

    // ── 6. Remove competitor promotional slogans / taglines ────────────────
    // Lines with pure promotional text that don't contain load info
    const promoPatterns = [
        /^[^\n]*\b(best\s+(?:service|rates?|price)|lowest\s+(?:rates?|price)|sabse\s+sasta|no\.?\s*1\s+transport|trusted\s+(?:by|since)|years?\s+of\s+experience|professional\s+service|quality\s+service|fast\s+delivery|safe\s+delivery|door\s+to\s+door)\b[^\n]*$/gim,
        /^[^\n]*(हमारी सेवा|हमारे साथ|हम देते हैं|बेस्ट सर्विस|सबसे सस्ता|नंबर 1)[^\n]*$/gim,
    ];
    for (const pattern of promoPatterns) {
        cleaned = cleaned.replace(pattern, '');
    }

    // ── 7. Clean up leftover punctuation-only lines and extra blank lines ───
    cleaned = cleaned.replace(/^[\s\-–—:,|•*]+$/gm, ''); // lines with only punctuation
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    return cleaned;
}




function formatDeterministicGroupMessage(originalText, isUrgent) {
    const db = sharedContext.db;
    const ownerNumber = db.settings.ownerNumber || "8200210397";
    const ownerEmail = db.settings.ownerEmail || "supportglobalunido@gmail.com";
    const ownerCompany = db.settings.ownerCompany || "GLOBALUNIDO";

    const parsed = parseLoadText(originalText);
    const cleanedText = cleanMessageText(originalText);
    const dateStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
    
    let msg = ``;
    if (isUrgent) {
        msg += `🚨🚨 *URGENT LOAD REQUIREMENT* 🚨🚨\n`;
    } else {
        msg += `🚛 *${ownerCompany} — LOAD REQUIREMENT* 🚛\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📅 *Date:* ${dateStr}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    // Route — sirf tab dikhao jab dono from aur to clearly pata ho
    if (parsed.fromPlace !== "Anywhere" && parsed.toPlace !== "Anywhere") {
        msg += `📍 *Route:* ${parsed.fromPlace.toUpperCase()} ➡️ ${parsed.toPlace.toUpperCase()}\n`;
    }
    
    // Vehicle — sirf tab dikhao jab clearly pata ho
    if (parsed.vehicleInfo && parsed.vehicleInfo !== "Any Truck Required") {
        msg += `🚛 *Vehicle:* ${parsed.vehicleInfo}\n`;
    }
    
    // Material/Weight — sirf tab dikhao jab clearly pata ho
    if (parsed.materialInfo && parsed.materialInfo !== "Industrial Cargo") {
        msg += `📦 *Cargo/Weight:* ${parsed.materialInfo}\n`;
    }
    
    // Original cleaned load details
    msg += `\n📝 *Load Details:*\n${cleanedText}\n`;
    
    msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📞 *Contact:* +91 ${ownerNumber}\n`;
    msg += `📧 *Email:* ${ownerEmail}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `_🇮🇳 ${ownerCompany} — Safe & Guaranteed Payments_`;
    
    return msg;
}

// Function to save loads into a local Excel file on Desktop
function saveToExcel(channelName, originalNumber, originalEmail, fullMessage) {
    try {
        const db = sharedContext.db;
        let workbook;
        let worksheet;
        let data = [];

        const newRow = {
            "Date & Time": new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
            "Channel Name": channelName,
            "Original Contact": originalNumber || "N/A",
            "Original Email": originalEmail || "N/A",
            "Full Message": fullMessage
        };

        const excelPath = getExcelPath(db);
        if (fs.existsSync(excelPath)) {
            workbook = XLSX.readFile(excelPath);
            worksheet = workbook.Sheets["Loads"];
            if (worksheet) {
                data = XLSX.utils.sheet_to_json(worksheet);
            }
        } else {
            workbook = XLSX.utils.book_new();
        }

        data.push(newRow);
        worksheet = XLSX.utils.json_to_sheet(data);

        // Adjust column widths
        worksheet['!cols'] = [
            { wch: 22 }, // Date & Time
            { wch: 30 }, // Channel Name
            { wch: 20 }, // Original Contact
            { wch: 30 }, // Original Email
            { wch: 60 }  // Full Message
        ];

        workbook.Sheets["Loads"] = worksheet;
        if (!workbook.SheetNames.includes("Loads")) {
            workbook.SheetNames.push("Loads");
        }

        XLSX.writeFile(workbook, excelPath);
        console.log(`[✔] Load saved to Excel: ${excelPath}`);
    } catch (error) {
        console.error('[!] Error saving to Excel:', error.message);
    }
}

// Global target groups WID cache to speed up forwarding
global.targetGroupsCache = global.targetGroupsCache || new Map();
// Global target channel WID cache
global.targetChannelCache = global.targetChannelCache || null;

// Helper to handle a confirmed load (forwarding, logging, auto-matching)
async function processConfirmedLoad(channelName, originalNumber, originalEmail, originalText, modifiedText, isUrgent = false, mediaData = null) {
    try {
        const db = sharedContext.db;
        const ownerNumber = db.settings.ownerNumber || "8200210397";
        const ownerEmail = db.settings.ownerEmail || "supportglobalunido@gmail.com";
        const ownerCompany = db.settings.ownerCompany || "GLOBALUNIDO";

        // Refine message with Gemini AI (using media if present)
        let refinedText = await refineLoadMessageWithAI(originalText, mediaData);
        if (!refinedText) {
            refinedText = formatDeterministicGroupMessage(originalText || "", isUrgent);
        }

        // Feature: Competitor Data Collector
        // If it's from a competitor and has a price, save it and ABORT forwarding
        const priceMatch = refinedText.match(/Expected Market Rate:\s*₹?\s*(\d+[,\d]*)/i);
        const routeMatch = refinedText.match(/Route:\s*(.*)/i);
        const vehicleMatch = refinedText.match(/Vehicle:\s*(.*)/i);
        
        // Let's assume if it has a hard price (not 'Open' or 'N/A') in the original text, we steal it.
        // But the AI generates 'Expected Market Rate'. To be safe, if original text had a price, we abort.
        const originalHasPrice = originalText && /(rs|rupees|₹|bhada|rate|price)\s*:?\s*\d{3,}/i.test(originalText);
        if (originalHasPrice) {
            console.log("[i] Competitor Price detected! Saving to Excel and CONTINUING forward...");
            const route = routeMatch ? routeMatch[1] : "Unknown";
            const vehicle = vehicleMatch ? vehicleMatch[1] : "Unknown";
            const rate = priceMatch ? priceMatch[1] : "Unknown";
            saveCompetitorRate(route, vehicle, rate);
            // Deliberately NOT returning here so the user's drivers still receive the load
        }

        // Feature: Part-Load Consolidation
        const weightMatch = refinedText.match(/Material\/Weight:.*\/\s*(\d+)\s*(MT|Tons|Ton)/i);
        if (weightMatch) {
            const weight = parseInt(weightMatch[1]);
            if (weight <= 10) { // It's a part load
                const route = routeMatch ? routeMatch[1].trim() : "Unknown";
                
                // Check if we have another part load for this route in cache
                const matchIndex = global.partLoadsCache.findIndex(pl => pl.route === route);
                if (matchIndex !== -1) {
                    const matchedLoad = global.partLoadsCache[matchIndex];
                    global.partLoadsCache.splice(matchIndex, 1); // remove it
                    const combinedWeight = matchedLoad.weight + weight;
                    console.log(`[!] Consolidated Load Triggered! ${matchedLoad.weight}MT + ${weight}MT = ${combinedWeight}MT for ${route}`);
                    
                    refinedText = refinedText.replace("🚚 *FRESH LOAD REQUIREMENT* 📦", "🚨 *FULL TRUCK LOAD (Consolidated)* 🚨");
                    refinedText = refinedText.replace(/Material\/Weight:(.*)/i, `Material/Weight: Mixed / ${combinedWeight} MT`);
                } else {
                    // Buffer it for 1 minute (for demo/practicality)
                    console.log(`[i] Part load detected (${weight}MT). Buffering for 1 minute for consolidation...`);
                    global.partLoadsCache.push({ route, weight, refinedText });
                    
                    // After 1 min, if it's still in cache, forward it
                    setTimeout(async () => {
                        const stillExists = global.partLoadsCache.findIndex(pl => pl.refinedText === refinedText);
                        if (stillExists !== -1) {
                            global.partLoadsCache.splice(stillExists, 1);
                            console.log(`[i] No match found for buffered part load. Forwarding as is.`);
                            await finishForwarding(refinedText, channelName, originalNumber, originalEmail, originalText, isUrgent);
                        }
                    }, 5000);
                    return; // ABORT FORWARDING FOR NOW
                }
            }
        }

        await finishForwarding(refinedText, channelName, originalNumber, originalEmail, originalText, isUrgent);
        
        // --- ASK FOR RATE IF MISSING ---
        if (!originalHasPrice && originalNumber && sharedContext && sharedContext.getClient) {
            const cleanedNum = originalNumber.replace(/\D/g, '');
            const targetWID = cleanedNum.length === 10 ? '91' + cleanedNum + '@c.us' : cleanedNum + '@c.us';
            const routeFriendly = routeMatch ? routeMatch[1].replace('➔', 'se').trim() : "gaadi";
            
            setTimeout(async () => {
                try {
                    const cl = sharedContext.getClient();
                    if (cl) {
                        await cl.sendMessage(targetWID, `Sir, aapne jo ${routeFriendly} ka load dala tha, uska kya bhada (rate) de rahe ho aap?`);
                        console.log(`[+] Auto-asked for rate from ${targetWID} for ${routeFriendly}`);
                    }
                } catch (e) {
                    console.error("[!] Failed to auto-ask rate:", e.message);
                }
            }, 3000);
        }
    } catch (e) {
        console.error('[!] Error in processConfirmedLoad:', e.message);
    }
}

async function finishForwarding(refinedText, channelName, originalNumber, originalEmail, originalText, isUrgent) {
    try {
        const db = sharedContext.db;
        
        // --- LOAD BOOKING SYSTEM ---
        global.activeLoads = global.activeLoads || {};
        const loadId = `GU-${Math.floor(1000 + Math.random() * 9000)}`;
        
        // Extract route for tracking
        let routeStr = "Check Message Details";
        const lines = refinedText.split('\n');
        const routeLine = lines.find(l => l.includes('📍 *Route:*'));
        if (routeLine) {
            routeStr = routeLine.replace('📍 *Route:*', '').trim();
        }

        global.activeLoads[loadId] = {
            originalNumber: originalNumber,
            route: routeStr,
            status: 'open',
            channelName: channelName,
            time: Date.now()
        };
        if (typeof broadcastActiveLoads === 'function') broadcastActiveLoads();

        let textToSend = refinedText + `\n\n👉 *Is gaadi ko book karne ke liye reply karein:*\n\`.accept ${loadId}\``;
        textToSend += `\n\n🌐 *Follow Our WhatsApp Channel:*\nhttps://whatsapp.com/channel/0029Vb7tmjlGE56twzsONP2s`;

        // 1. Forward to WhatsApp Groups
        const targetGroupNames = db.settings.targetGroups || [];
        for (const tgName of targetGroupNames) {
            let targetGroupWID = global.targetGroupsCache.get(tgName);
            
            if (!targetGroupWID) {
                console.log(`[i] Target group "${tgName}" not in cache. Fetching chats to find ID...`);
                const chats = await client.getChats();
                
                // Filter all groups that have valid names
                const groupChats = chats.filter(c => c.isGroup && c.name);
                
                let bestMatch = null;
                let highestScore = 0.0;
                
                // 1. First, search for a case-insensitive exact match
                const exactMatch = groupChats.find(c => c.name.toLowerCase().trim() === tgName.toLowerCase().trim());
                if (exactMatch) {
                    bestMatch = exactMatch;
                    highestScore = 1.0;
                } else {
                    // Helper to clean strings
                    const cleanString = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
                    const cleanT = cleanString(tgName);
                    
                    // 2. Search for exact clean match
                    const cleanExactMatch = groupChats.find(c => cleanString(c.name) === cleanT);
                    if (cleanExactMatch) {
                        bestMatch = cleanExactMatch;
                        highestScore = 0.99;
                    } else {
                        // 3. Score all group chats using Levenshtein distance to find the best near-match
                        const getSimilarityScore = (str1, str2) => {
                            const s1 = cleanString(str1);
                            const s2 = cleanString(str2);
                            if (s1 === s2) return 1.0;
                            if (!s1 || !s2) return 0.0;
                            
                            // Distance calculation
                            const track = Array(s2.length + 1).fill(null).map(() => Array(s1.length + 1).fill(null));
                            for (let i = 0; i <= s1.length; i += 1) track[0][i] = i;
                            for (let j = 0; j <= s2.length; j += 1) track[j][0] = j;
                            for (let j = 1; j <= s2.length; j += 1) {
                                for (let i = 1; i <= s1.length; i += 1) {
                                    const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
                                    track[j][i] = Math.min(
                                        track[j - 1][i] + 1,
                                        track[j][i - 1] + 1,
                                        track[j - 1][i - 1] + indicator
                                    );
                                }
                            }
                            const distance = track[s2.length][s1.length];
                            const maxLength = Math.max(s1.length, s2.length);
                            return 1.0 - (distance / maxLength);
                        };
                        
                        for (const c of groupChats) {
                            const cNameLower = c.name.toLowerCase();
                            const tgNameLower = tgName.toLowerCase();
                            
                            // Check if they share at least one significant keyword
                            const hasKeywordOverlap = ['globalunido', 'loading', 'requirement', 'requirment', 'requirements', 'requirments'].some(kw => 
                                cNameLower.includes(kw) && tgNameLower.includes(kw)
                            );
                            
                            if (hasKeywordOverlap) {
                                const score = getSimilarityScore(c.name, tgName);
                                if (score > highestScore) {
                                    highestScore = score;
                                    bestMatch = c;
                                }
                            }
                        }
                    }
                }
                
                // Only accept best match if it is highly similar (score >= 0.75)
                let targetGroup = null;
                if (bestMatch && highestScore >= 0.75) {
                    targetGroup = bestMatch;
                    console.log(`[✔] Match found for target "${tgName}": "${bestMatch.name}" with confidence score ${(highestScore * 100).toFixed(1)}%`);
                } else {
                    console.log(`[❌] No highly confident match found for target "${tgName}". Highest score: ${(highestScore * 100).toFixed(1)}%`);
                }

                if (targetGroup) {
                    targetGroupWID = targetGroup.id._serialized;
                    global.targetGroupsCache.set(tgName, targetGroupWID);
                    console.log(`[✔] Cached group ID for "${tgName}": ${targetGroupWID}`);
                }
            }

            if (targetGroupWID) {
                await client.sendMessage(targetGroupWID, textToSend);
                console.log(`[✔] Confirmed load forwarded to group: ${tgName}`);
                db.stats.messagesSent++;
            } else {
                console.log(`[❌] Error: Could not find target group named "${tgName}".`);
            }
        }
        
        sharedContext.saveDb(db);
        sharedContext.broadcastWS('stats', db.stats);

        // 1.5. Forward to WhatsApp Channel (same message, non-blocking)
        const targetChannelName = db.settings.targetChannel || '';
        if (targetChannelName) {
            try {
                let channelWID = global.targetChannelCache;
                if (!channelWID) {
                    if (targetChannelName.toLowerCase().includes('globalunido')) {
                        channelWID = '120363171914862438@newsletter';
                        global.targetChannelCache = channelWID;
                        console.log(`[✔] Hardcoded Channel ID applied for Globalunido.in: ${channelWID}`);
                    } else {
                        console.log(`[i] Looking for WhatsApp Channel: "${targetChannelName}"...`);
                        const allChats = await client.getChats();
                        const channelChat = allChats.find(c => {
                            const name = (c.name || '').toLowerCase().trim();
                            const target = targetChannelName.toLowerCase().trim();
                            if (!name || !target) return false;
                            if (!c.id._serialized.includes('@newsletter')) return false;
                            return name === target || name.includes(target);
                        });
                        if (channelChat) {
                            channelWID = channelChat.id._serialized;
                            global.targetChannelCache = channelWID;
                            console.log(`[✔] Found WhatsApp Channel "${channelChat.name}" | ID: ${channelWID}`);
                        } else {
                            console.log(`[❌] WhatsApp Channel "${targetChannelName}" not found in chat list.`);
                        }
                    }
                }
                if (channelWID) {
                    const channelChat = await client.getChatById(channelWID);
                    await channelChat.sendMessage(refinedText);
                    console.log(`[✔] Message also sent to WhatsApp Channel: "${targetChannelName}"`);
                    db.stats.messagesSent++;
                    sharedContext.saveDb(db);
                    sharedContext.broadcastWS('stats', db.stats);
                }
            } catch (chErr) {
                console.error(`[!] Error forwarding to WhatsApp Channel:`, chErr.message);
            }
        }

        // 1.6. Forward to Instagram DM Groups (non-blocking background task)
        if (db.settings.instagramEnabled !== false) {
            for (const tgName of targetGroupNames) {
                sendToInstagramGroup(tgName, textToSend).then(() => {
                    console.log(`[✔] Instagram background DM group forward finished for ${tgName}.`);
                }).catch(e => {
                    console.error(`[!] Instagram DM group forward error for ${tgName}:`, e.message);
                });
            }
        }

        // 2. Save to Excel
        saveToExcel(channelName, originalNumber, originalEmail, textToSend);

        // Keep track of recent loads in-memory for Zabir Personal Assistant
        global.recentProcessedLoads = global.recentProcessedLoads || [];
        global.recentProcessedLoads.push({
            time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
            channel: channelName,
            targets: targetGroupNames,
            text: originalText,
            formattedText: textToSend,
            senderNumber: originalNumber || 'System/Dashboard'
        });
        if (global.recentProcessedLoads.length > 10) {
            global.recentProcessedLoads.shift();
        }
        sharedContext.broadcastWS('loads', global.recentProcessedLoads);

        // Send internal tracking summary to Owner
        try {
            const ownerNumber = db.settings.ownerNumber || "8200210397";
            const ownerWID = `91${ownerNumber.replace(/\D/g, '')}@c.us`;
            let routeStr = "Check Message Details";
            const lines = textToSend.split('\n');
            const routeLine = lines.find(l => l.includes('📍 *Route:*'));
            if (routeLine) {
                routeStr = routeLine.replace('📍 *Route:*', '').trim();
            }
            const clickToChat = originalNumber ? `wa.me/${originalNumber.replace(/\D/g, '')}` : 'N/A';
            const ownerNotification = `🚨 *LIVE LOAD CAPTURED & FORWARDED*\n\n📍 *Route:* ${routeStr}\n📞 *Original Sender:* ${originalNumber || 'Unknown'}\n🔗 *Chat Link:* ${clickToChat}\n🏢 *Source Group:* ${channelName}\n🕒 *Time:* ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n_Note: This load has been automatically formatted and forwarded to your network._`;
            
            await client.sendMessage(ownerWID, ownerNotification);
            console.log("[✔] Owner notified successfully.");
        } catch (e) {
            console.error("[!] Failed to notify owner:", e.message);
        }

        // --- VIP DRIVER SMART MATCH ---
        try {
            const cities = routeStr.split(/to|se|-|➔|➡️|से/i).map(c => c.trim().toLowerCase());
            const drivers = loadDrivers();
            const vipDrivers = drivers.filter(d => 
                d.favoriteRoutes && d.favoriteRoutes.some(fr => cities.includes(fr))
            );
            if (vipDrivers.length > 0) {
                setTimeout(async () => {
                    for (const vip of vipDrivers) {
                        try {
                            const vipWID = vip.phone.length === 10 ? '91' + vip.phone + '@c.us' : vip.phone + '@c.us';
                            const vipMsg = `🎯 *VIP SMART MATCH* 🎯\nSir, aapke favourite route (${routeStr}) ka naya load aaya hai!\n\n${refinedText}\n\n👉 *Book karne ke liye jaldi reply karein:*\n\`.accept ${loadId}\``;
                            await client.sendMessage(vipWID, vipMsg);
                            console.log(`[+] Pushed VIP match to ${vip.phone} for route ${routeStr}`);
                        } catch(e) {}
                    }
                }, 4000);
            }
        } catch(e) {
            console.error("[!] VIP Smart Match failed:", e.message);
        }

        // 6. Smart Driver Matchmaking (Executed instantly after forwarding text)
        try {
            const drivers = loadDrivers();
            const matchedDrivers = [];
            const loadWords = originalText.toLowerCase().replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/).filter(w => w.length >= 4);

            for (const driver of drivers) {
                const driverMsgClean = driver.message.toLowerCase();
                const hasMatch = loadWords.some(word => {
                    const ignores = ['load', 'gadi', 'khali', 'truck', 'chahiye', 'available', 'required', 'transport', 'service', 'lines', 'roadways'];
                    if (ignores.includes(word)) return false;
                    return driverMsgClean.includes(word);
                });

                if (hasMatch) {
                    matchedDrivers.push(driver);
                }
            }

            for (const driver of matchedDrivers) {
                const driverNotification = `नमस्ते भाई साहब! आपकी गाड़ी के लिए एक *कन्फर्म लोड* मिला है! 🚚\n\n*लोड डिटेल्स:*\n${textToSend}\n\n*तुरंत संपर्क करें (कॉल करें):* 📞 ${ownerNumber}`;
                await client.sendMessage(driver.sender, driverNotification);
                console.log(`[✔] Auto-match: Sent load alert to driver ${driver.sender}`);
                db.stats.messagesSent++;
                sharedContext.saveDb(db);
                sharedContext.broadcastWS('stats', db.stats);
            }
        } catch (matchErr) {
            console.error('[!] Error in driver matchmaking:', matchErr.message);
        }

        return textToSend;
    } catch (e) {
        console.error('[!] Error in processConfirmedLoad:', e.message);
    }
    return null;
}

// --- 2. AUTOMATION CLIENT CONTROLLER ---
function cleanSessionLocks() {
    const sessionDir = path.join(__dirname, '..', '.wwebjs_auth');
    if (!fs.existsSync(sessionDir)) return;
    
    console.log('[i] Checking for and cleaning Chrome lock files in session directory...');
    function deleteLocks(dir) {
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    deleteLocks(fullPath);
                } else if (file === 'SingletonLock' || file === 'lock' || file.includes('lock')) {
                    fs.unlinkSync(fullPath);
                    console.log(`[✔] Deleted active session lock file: ${fullPath}`);
                }
            }
        } catch (e) {
            // Ignore lock file error
        }
    }
    deleteLocks(sessionDir);
}

function getChromeExecutablePath() {
    if (process.platform === 'win32') return null; // Default Windows binary path
    
    const cacheDir = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
    console.log(`[i] Searching for Chrome executable in cache dir: ${cacheDir}`);
    
    function searchChrome(dir) {
        if (!fs.existsSync(dir)) return null;
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    const found = searchChrome(fullPath);
                    if (found) return found;
                } else if (file === 'chrome') {
                    return fullPath;
                }
            }
        } catch (e) {
            // Ignore directory search read error
        }
        return null;
    }
    
    const foundPath = searchChrome(cacheDir);
    if (foundPath) {
        console.log(`[✔] Located Chrome executable: ${foundPath}`);
        return foundPath;
    }
    
    const fallbacks = [
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
    ];
    for (const fb of fallbacks) {
        if (fs.existsSync(fb)) {
            console.log(`[✔] Using fallback Chrome path: ${fb}`);
            return fb;
        }
    }
    
    console.log('[!] Warning: Could not locate Chrome executable. Falling back to default Puppeteer launch.');
    return null;
}

function setupEventListeners() {
    const db = sharedContext.db;

    client.on('remote_session_saved', () => {
        console.log('[✔] Remote session successfully saved/backed up to MongoDB Atlas!');
    });

    client.on('qr', (qr) => {
        console.log('\n[!] Please SCAN the QR Code below with your WhatsApp:\n');
        qrcode.generate(qr, { small: true });
        sharedContext.setBotState('qr', qr); // Pass QR to dashboard
        console.log('[i] QR Code generated. Visit the web page or terminal to scan.');
    });

    client.on('ready', async () => {
        console.log('\n[✔] WhatsApp Web is Ready & Automation Started!');
        console.log(`[i] Listening for messages from these channels: ${(db.settings.sourceChannels || []).join(", ")}`);
        console.log(`[i] Will forward to groups: "${(db.settings.targetGroups || []).join('", "')}"\n`);
        
        try {
            console.log('[i] Fetching list of all group chats to verify target group matching...');
            const chats = await client.getChats();
            const groups = chats.filter(c => c.isGroup);
            console.log(`[i] Total group chats found: ${groups.length}`);
            groups.forEach(g => {
                if (g.name.toLowerCase().includes('globalunido') || g.name.toLowerCase().includes('loading')) {
                    console.log(`    -> Group Name: "${g.name}" | ID: ${g.id._serialized}`);
                }
            });
            const newsletters = chats.filter(c => c.id && c.id._serialized && c.id._serialized.includes('@newsletter'));
            console.log(`[i] Total WhatsApp Channels (Newsletters) found: ${newsletters.length}`);
            newsletters.forEach(n => {
                console.log(`    -> Channel Name: "${n.name}" | ID: ${n.id._serialized}`);
            });
        } catch (err) {
            console.error('[!] Failed to log group list:', err.message);
        }

        sharedContext.setBotState('ready', 'Zabir AI WhatsApp Engine is fully active.');
    });

    client.on('authenticated', () => {
        console.log('[✔] WhatsApp session authenticated successfully!');
        sharedContext.setBotState('connecting', 'Authenticating and downloading chat lists...');
    });

    client.on('auth_failure', (msg) => {
        console.error('[!] Auth failure:', msg);
        sharedContext.setBotState('disconnected', `Auth failed: ${msg}. Purge session and retry.`);
    });

    client.on('disconnected', (reason) => {
        console.log('[!] WhatsApp client disconnected:', reason);
        sharedContext.setBotState('disconnected', `Disconnected: ${reason}. Restarting client...`);
    });

    client.on('message', async (msg) => {
        try {
            const chat = await msg.getChat();
            await processIncomingMessage(msg, chat, msg.body);
        } catch (err) {
            console.error('[!] Error processing message:', err.message);
        }
    });

    client.on('message_create', async (msg) => {
        try {
            if (msg.to && msg.to.includes('@newsletter')) {
                console.log(`[i] Message created in a Channel! Channel ID is: ${msg.to}`);
            }
            if (msg.fromMe) {
                const chat = await msg.getChat();
                await processIncomingMessage(msg, chat, msg.body);
            }
        } catch (err) {
            console.error('[!] Error processing message_create:', err.message);
        }
    });
}

// Main Message Processor
global.pendingBargains = global.pendingBargains || new Map();

// Competitor Rates logging
function saveCompetitorRate(route, vehicle, rate) {
    const filePath = 'C:\\Users\\Admin\\Desktop\\Competitor_Rates.xlsx';
    let wb, ws;
    if (fs.existsSync(filePath)) {
        wb = XLSX.readFile(filePath);
        ws = wb.Sheets[wb.SheetNames[0]];
    } else {
        wb = XLSX.utils.book_new();
        ws = XLSX.utils.aoa_to_sheet([["Date", "Route", "Vehicle", "Price"]]);
        XLSX.utils.book_append_sheet(wb, ws, "Rates");
    }
    const data = XLSX.utils.sheet_to_json(ws, {header: 1});
    data.push([new Date().toLocaleString(), route, vehicle, rate]);
    const newWs = XLSX.utils.aoa_to_sheet(data);
    wb.Sheets[wb.SheetNames[0]] = newWs;
    XLSX.writeFile(wb, filePath);
}

// Consolidation logic
global.partLoadsCache = global.partLoadsCache || [];

function broadcastActiveLoads() {
    if (sharedContext && sharedContext.broadcastWS) {
        const loadsArr = Object.entries(global.activeLoads || {}).map(([id, data]) => ({ id, ...data }));
        sharedContext.broadcastWS('active_loads', loadsArr);
    }
}

async function processIncomingMessage(msg, chat, bodyRaw) {
    let body = bodyRaw || "";
    let mediaData = null;
    try {
        if (msg.hasMedia) {
            const media = await msg.downloadMedia();
            if (media && (media.mimetype.startsWith('image/') || media.mimetype.startsWith('audio/'))) {
                mediaData = media;
            }
        }
        if (!body && !mediaData) return;
        
        const db = sharedContext.db;
        db.stats.messagesReceived++;
        sharedContext.saveDb(db);
        sharedContext.broadcastWS('stats', db.stats);
        
        const senderNumber = msg.from.split('@')[0];
        const isFromMe = msg.fromMe;
        
        // --- 0. PHOTO VERIFICATION INTERCEPTION (DRIVER LOCKING LOAD) ---
        global.driverActiveLoads = global.driverActiveLoads || {};
        if (msg.hasMedia && global.driverActiveLoads[senderNumber]) {
            const loadId = global.driverActiveLoads[senderNumber];
            if (global.activeLoads && global.activeLoads[loadId]) {
                if (mediaData && mediaData.mimetype.startsWith('image/')) {
                    await chat.sendMessage(`⏳ *AI Scanning:* Aapki photo ko scan kiya jaa raha hai, kripya pratiksha karein...`);
                    const verificationResult = await verifyTruckPhotoWithAI(mediaData);
                    
                    if (verificationResult.startsWith('INVALID_PROOF')) {
                        const reason = verificationResult.replace('INVALID_PROOF:', '').trim();
                        await chat.sendMessage(`❌ *Invalid Photo!*\n${reason}`);
                        console.log(`[i] Driver ${senderNumber} sent an invalid photo for load ${loadId}.`);
                        return;
                    }
                }
                
                global.activeLoads[loadId].status = 'closed';
                // Set deadline for Auto-POD (48 hours from now)
                global.activeLoads[loadId].deliveryDeadline = Date.now() + (48 * 60 * 60 * 1000);
                if (typeof broadcastActiveLoads === 'function') broadcastActiveLoads();
                await chat.sendMessage(`✅ *Photo Verified & Load Locked!* Ye load (${global.activeLoads[loadId].route}) ab aapke naam par confirm ho gaya hai. Safe journey! 🚚💨`);
                console.log(`[✔] Load ${loadId} locked by driver ${senderNumber} via photo upload.`);
                delete global.driverActiveLoads[senderNumber];
                return;
            }
        }

        // --- 1. AUTO-BARGAINING INTERCEPTION ---
        if (!chat.isGroup && global.pendingBargains.has(senderNumber)) {
            const bargainState = global.pendingBargains.get(senderNumber);
            
            // Extract a number from their reply
            const numbers = body.match(/\d+/g);
            if (numbers && numbers.length > 0) {
                // Find a plausible price (e.g. > 1000)
                let price = parseInt(numbers.find(n => parseInt(n) >= 500) || numbers[0]);
                if (price >= 500) {
                    const addAmount = Math.random() > 0.5 ? 1000 : 2000;
                    const newPrice = price + addAmount;
                    
                    const reply = `Bhaiya thoda badha kar do, ${newPrice} tak chalega kya?`;
                    await chat.sendMessage(reply);
                    
                    // Update state with their latest proposed price just in case
                    bargainState.lastPrice = price;
                    global.pendingBargains.set(senderNumber, bargainState);
                    
                    console.log(`[i] Bargained with ${senderNumber}: User said ${price}, we asked for ${newPrice}`);
                    return; // Stop processing further
                }
            }
            
            // If no number found or they just said something else, just ask again or wait for timeout
            await chat.sendMessage("Bhaiya, amount (Rs) mein likh kar bataiye bhada kitna hai?");
            return;
        }

        
        const ownerNumber = db.settings.ownerNumber || "8200210397";
        const ownerEmail = db.settings.ownerEmail || "supportglobalunido@gmail.com";
        const ownerNumClean = ownerNumber.replace(/\D/g, '');
        const isOwner = (senderNumber.endsWith(ownerNumClean) || isFromMe);
        const prefix = db.settings.prefix || ".";
        
        // --- 1. ZABIR COMMANDS PARSER (.menu, .todo, .reminder, etc.) ---
        if (body.startsWith(prefix)) {
            db.stats.commandsExecuted++;
            sharedContext.saveDb(db);
            sharedContext.broadcastWS('stats', db.stats);
            
            const args = body.slice(prefix.length).trim().split(/ +/);
            const command = args.shift().toLowerCase();
            const query = args.join(' ');
            
            console.log(`[+] Executed command "${command}" from ${senderNumber}`);
            
            switch (command) {
                case 'menu':
                case 'help': {
                    let menuMsg = `🤖 *${db.settings.botName.toUpperCase()} - COMMANDS MENU* 🚚✨\n\n`;
                    menuMsg += `Hello *${db.settings.ownerName}*, I am your personal logistics & utility automation assistant. Here are my available triggers:\n\n`;
                    menuMsg += `🚚 *LOGISTICS TOOLS*\n`;
                    menuMsg += `👉 \`${prefix}khata [number] [amount] [reason]\` - Add pending payment.\n`;
                    menuMsg += `👉 \`${prefix}bilty [From] to [To], [Vehicle], [Material], [Rate]\` - Generate Lorry Receipt / Bilty instantly.\n\n`;
                    menuMsg += `👉 \`${prefix}accept [Load-ID]\` - Accept a load and get dispatch details.\n\n`;
                    menuMsg += `🛠️ *PLANNER & UTILITY TOOLS*\n`;
                    menuMsg += `👉 \`${prefix}todo add <text>\` - Save a quick logistics task.\n`;
                    menuMsg += `👉 \`${prefix}todo list\` - View pending tasks.\n`;
                    menuMsg += `👉 \`${prefix}todo done <num>\` - Tick off completed items.\n`;
                    menuMsg += `👉 \`${prefix}reminder <time> <msg>\` - Set smart alarm (e.g. \`10m\`, \`1h\`, \`30s\`).\n`;
                    menuMsg += `👉 \`${prefix}weather <city>\` - Live updates of Indian logistics hubs.\n\n`;
                    menuMsg += `🎭 *FUN & STATS*\n`;
                    menuMsg += `👉 \`${prefix}joke\` - Random premium comedy joke.\n`;
                    menuMsg += `👉 \`${prefix}quote\` - Inspiring quotes for transport drivers.\n`;
                    menuMsg += `👉 \`${prefix}trivia\` - Random quiz/trivia.\n`;
                    menuMsg += `👉 \`${prefix}stats\` - Bot diagnostics and message metrics.\n\n`;
                    menuMsg += `_Managed via sleek Glassmorphism Control Center._`;
                    
                    await chat.sendMessage(menuMsg);
                    db.stats.messagesSent++;
                    sharedContext.saveDb(db);
                    sharedContext.broadcastWS('stats', db.stats);
                    break;
                }
                
                case 'accept': {
                    const loadId = args[0] ? args[0].toUpperCase() : null;
                    if (!loadId || !loadId.startsWith('GU-')) {
                        await msg.reply(`❌ *Invalid Command:* Kripya sahi Load ID bhejein. Example: \`${prefix}accept GU-1234\``);
                        return;
                    }
                    global.activeLoads = global.activeLoads || {};
                    const loadData = global.activeLoads[loadId];
                    if (!loadData) {
                        await msg.reply(`❌ *Sorry!* Ye load ab available nahi hai ya expire ho chuka hai.`);
                        return;
                    }
                    if (loadData.status === 'closed') {
                        await msg.reply(`❌ *Sorry!* Ye load already lock (book) ho chuka hai.`);
                        return;
                    }
                    
                    // Track driver
                    global.driverActiveLoads = global.driverActiveLoads || {};
                    global.driverActiveLoads[senderNumber] = loadId;
                    
                    if (global.activeLoads[loadId]) {
                        global.activeLoads[loadId].lastAcceptedBy = senderNumber;
                        if (typeof broadcastActiveLoads === 'function') broadcastActiveLoads();
                    }

                    // Track VIP routes for driver
                    const route = loadData.route || '';
                    if (route && route !== 'Unknown') {
                        const drivers = loadDrivers();
                        let dIdx = drivers.findIndex(d => d.phone === senderNumber);
                        if (dIdx === -1) {
                            drivers.push({ name: 'VIP Driver', phone: senderNumber, message: 'VIP Tracker', favoriteRoutes: [] });
                            dIdx = drivers.length - 1;
                        }
                        drivers[dIdx].favoriteRoutes = drivers[dIdx].favoriteRoutes || [];
                        const cities = route.split(/to|se|-|➔|➡️|से/i).map(c => c.trim().toLowerCase());
                        cities.forEach(city => {
                            if (city && !drivers[dIdx].favoriteRoutes.includes(city)) {
                                drivers[dIdx].favoriteRoutes.push(city);
                            }
                        });
                        saveDrivers(drivers);
                    }
                    
                    if (loadData.originalNumber) {
                        const loaderCleanNum = loadData.originalNumber.replace(/\\D/g, '');
                        const dispatchMsg = `🚚 *LOAD DETAILS (Route: ${loadData.route})*\n\n📞 *Loader Contact:* +91 ${loaderCleanNum} (wa.me/${loaderCleanNum})\n_(Ye us location ka banda hai isse baat kar lo)_\n\n⚠️ *ATTENTION:* Jab gaadi load ho jaye, toh proof ke liye yaha ek PHOTO bhej dena. Photo aane ke baad hi ye load system mein LOCK (close) hoga! Usse pehle ye sabke liye open rahega.`;
                        await msg.reply(dispatchMsg);
                        console.log(`[✔] Load ${loadId} details given to driver ${senderNumber}. Waiting for photo to lock.`);
                    } else {
                        await msg.reply(`⚠️ *Warning:* Is load ka original sender number available nahi hai. Aap ise manually dashboard se check karein.`);
                    }
                    return;
                }
                case 'bilty': {
                    if (!query) {
                        await msg.reply(`❌ *Usage:* \`${prefix}bilty [From] to [To], [Vehicle], [Material], [Rate]\`\n\n*Example:* \`${prefix}bilty Latur to Mumbai, 14-Wheeler, Sugar 25 Ton, Rate 45000\``);
                        break;
                    }
                    await msg.reply('⏳ _Generating professional Bilty / Lorry Receipt..._');
                    try {
                        const parsed = parseLoadText(query);
                        const rateMatch = query.match(/(rate|amount|rs|₹)[:\s]*(\d[\d,]*)/i);
                        const rateAmount = rateMatch ? rateMatch[2].replace(/,/g,'') : 'As Agreed';
                        const vehicleMatch = query.match(/(\d{2}\s*wheeler|container|trailer|lpt|eicher|tata ace|tempo|bolero)/i);
                        const vehicle = vehicleMatch ? vehicleMatch[0].toUpperCase() : parsed.vehicleInfo;
                        const materialMatch = query.match(/,\s*([a-zA-Z\s]+(?:\d+\s*(?:ton|mt|kg))?)/i);
                        const material = materialMatch ? materialMatch[1].trim() : parsed.materialInfo;
                        const biltyNo = `GU-${Date.now().toString().slice(-6)}`;
                        const dateStr = new Date().toLocaleDateString('en-IN');
                        
                        const biltyText = `📄 *GLOBALUNIDO LOGISTICS*
*LORRY RECEIPT / BILTY*
*LR NO:* ${biltyNo}
📅 *Date:* ${dateStr}
━━━━━━━━━━━━━━━━━━━━━━
📍 *FROM:* ${parsed.fromPlace.toUpperCase()}
📍 *TO:* ${parsed.toPlace.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━━━
🚛 *Vehicle Type:* ${vehicle}
📦 *Material:* ${material}
💰 *Freight Amount:* ₹${rateAmount}/-
━━━━━━━━━━━━━━━━━━━━━━
🏢 *Booking Agent:*
   ${db.settings.ownerCompany || "GLOBALUNIDO"}
   📞 ${ownerNumber}
   📧 ${db.settings.ownerEmail || "supportglobalunido@gmail.com"}
━━━━━━━━━━━━━━━━━━━━━━
✅ *Status:* CONFIRMED BOOKING
_Generated by Zabir Bot • GLOBALUNIDO_`;

                        await chat.sendMessage(biltyText);
                        db.stats.messagesSent++;
                        sharedContext.saveDb(db);
                        sharedContext.broadcastWS('stats', db.stats);
                    } catch(err) {
                        await msg.reply(`❌ Bilty error: ${err.message}`);
                    }
                    break;
                }
                case 'khata':
                    if (actualSenderNumber !== ownerNumber) {
                        await msg.reply(`❌ Sirf admin is command ko use kar sakta hai.`);
                        return;
                    }
                    if (args.length < 2) {
                        await msg.reply(`❌ *Usage:* \`${prefix}khata [number] [amount] [reason]\`\n*Example:* \`${prefix}khata 9876543210 5000 Freight pending\``);
                        return;
                    }
                    const kNumber = args[0].replace(/\D/g, '');
                    const kAmount = parseFloat(args[1]);
                    const kReason = args.slice(2).join(' ');
                    if (isNaN(kAmount) || kNumber.length < 10) {
                        await msg.reply(`❌ Invalid number or amount.`);
                        return;
                    }
                    const khataData = loadKhata();
                    khataData[kNumber] = { pendingAmount: kAmount, reason: kReason, updated: Date.now() };
                    if (kAmount === 0) {
                        delete khataData[kNumber];
                        await msg.reply(`✅ *Khata Cleared!* ${kNumber} ka hisaab clear kar diya gaya hai.`);
                    } else {
                        await msg.reply(`✅ *Khata Saved!* ${kNumber} ke naam par ₹${kAmount} pending save ho gaya hai. Roz subah 10 baje inko auto-reminder jayega.`);
                    }
                    saveKhata(khataData);
                    break;
                
                case 'todo': {
                    const subcmd = args[0] ? args[0].toLowerCase() : 'list';
                    db.todoList = db.todoList || [];
                    
                    if (subcmd === 'add') {
                        const taskText = args.slice(1).join(' ');
                        if (!taskText) {
                            await msg.reply(`❌ Usage: \`${prefix}todo add [Task Description]\``);
                            return;
                        }
                        db.todoList.push({ id: Date.now(), text: taskText, completed: false });
                        sharedContext.saveDb(db);
                        await msg.reply(`✅ Added task: "${taskText}"`);
                        db.stats.messagesSent++;
                        sharedContext.saveDb(db);
                        sharedContext.broadcastWS('stats', db.stats);
                        sharedContext.broadcastWS('init', {
                            settings: db.settings,
                            autoReplies: db.autoReplies,
                            stats: db.stats,
                            loads: global.recentProcessedLoads || [],
                            drivers: loadDrivers(),
                            todos: db.todoList
                        });
                    } 
                    else if (subcmd === 'done') {
                        const index = parseInt(args[1]) - 1;
                        if (isNaN(index) || index < 0 || index >= db.todoList.length) {
                            await msg.reply(`❌ Invalid index. Use \`${prefix}todo list\`.`);
                            return;
                        }
                        db.todoList[index].completed = true;
                        const text = db.todoList[index].text;
                        db.todoList.splice(index, 1);
                        sharedContext.saveDb(db);
                        await msg.reply(`🏆 Completed: "${text}"!`);
                        db.stats.messagesSent++;
                        sharedContext.saveDb(db);
                        sharedContext.broadcastWS('stats', db.stats);
                        sharedContext.broadcastWS('init', {
                            settings: db.settings,
                            autoReplies: db.autoReplies,
                            stats: db.stats,
                            loads: global.recentProcessedLoads || [],
                            drivers: loadDrivers(),
                            todos: db.todoList
                        });
                    } 
                    else {
                        if (db.todoList.length === 0) {
                            await chat.sendMessage(`📋 *Todo List:* Empty! No pending logistics jobs.`);
                            return;
                        }
                        let listMsg = `📋 *PENDING LOGISTICS TASKS:* \n\n`;
                        db.todoList.forEach((todo, idx) => {
                            listMsg += `${idx + 1}. [ ] ${todo.text}\n`;
                        });
                        listMsg += `\n_Mark done using \`${prefix}todo done <number>\`_`;
                        await chat.sendMessage(listMsg);
                    }
                    break;
                }
                
                case 'reminder': {
                    const timeArg = args[0];
                    const reminderText = args.slice(1).join(' ');
                    
                    if (!timeArg || !reminderText) {
                        await msg.reply(`❌ Usage: \`${prefix}reminder 10m call driver rahul\``);
                        return;
                    }
                    
                    const unit = timeArg.slice(-1).toLowerCase();
                    const numericVal = parseFloat(timeArg.slice(0, -1));
                    
                    if (isNaN(numericVal) || numericVal <= 0) {
                        await msg.reply(`❌ Invalid time format. Use: s, m, h (e.g. \`10m\`).`);
                        return;
                    }
                    
                    let ms = numericVal * 1000;
                    if (unit === 'm') ms = numericVal * 60 * 1000;
                    if (unit === 'h') ms = numericVal * 60 * 60 * 1000;
                    
                    const targetTime = new Date(Date.now() + ms);
                    
                    db.reminders = db.reminders || [];
                    const reminderId = Date.now();
                    db.reminders.push({
                        id: reminderId,
                        time: targetTime.toISOString(),
                        text: reminderText,
                        recipient: msg.from
                    });
                    sharedContext.saveDb(db);
                    
                    await msg.reply(`🔔 *Reminder Set!* I will ping you in *${timeArg}* about: "${reminderText}"`);
                    
                    setTimeout(async () => {
                        try {
                            const freshDb = sharedContext.db;
                            const idx = (freshDb.reminders || []).findIndex(r => r.id === reminderId);
                            if (idx !== -1) {
                                const alarmMsg = `🚨 *REMINDER ALARM!* 🚨\n\nBoss, you asked me to remind you about:\n 👉 "*${reminderText}*"\n\n_Time scheduled: ${new Date(targetTime).toLocaleTimeString()}_`;
                                await client.sendMessage(msg.from, alarmMsg);
                                freshDb.reminders.splice(idx, 1);
                                sharedContext.saveDb(freshDb);
                            }
                        } catch (err) {
                            console.error('Failed to trigger reminder:', err.message);
                        }
                    }, ms);
                    
                    break;
                }
                
                case 'weather': {
                    if (!query) {
                        await msg.reply(`❌ Usage: \`${prefix}weather [City Name]\``);
                        return;
                    }
                    const mockWeathers = [
                        `🌦 *WEATHER REPORT FOR ${query.toUpperCase()}:*\n🌡 *Temperature:* 32°C\n💧 *Humidity:* 65%\n💨 *Logistics Conditions:* Safe for transportation and trucks. Highways are dry and clear! 🚚✔`,
                        `☀️ *WEATHER REPORT FOR ${query.toUpperCase()}:*\n🌡 *Temperature:* 38°C (Extreme Heat!)\n💧 *Humidity:* 40%\n🥵 *Logistics Warning:* Heavy heatwave! Advise drivers to rest during peak afternoon hours and drink plenty of water. 🧴🚛`,
                        `🌧 *WEATHER REPORT FOR ${query.toUpperCase()}:*\n🌡 *Temperature:* 24°C\n☔ *Precipitation:* Heavy Rain!\n⚠️ *Logistics Warning:* Water logging possible near underpasses. Advise drivers to secure tarpaulin (Tadpatri) properly on open trucks! ☔🚚`
                    ];
                    await chat.sendMessage(mockWeathers[Math.floor(Math.random() * mockWeathers.length)]);
                    break;
                }
                
                case 'joke': {
                    const jokes = [
                        "Truck driver client se: 'Saheb, main rasta bhatak gaya hoon.'\nClient: 'Kahaan ho abhi?'\nDriver: 'Gadi ke andar!' 🚚😹",
                        "Why do engineers prefer dark mode? Because light attracts bugs! 💻🐛",
                        "Ek shaks ne driver se pucha: 'Tumhe driving seekhne me kitna waqt laga?'\nDriver: 'Bas char car-ein aur do deewarein!' 🚗💥"
                    ];
                    await chat.sendMessage(`🎭 *ZABIR COMEDY CORNER:* \n\n${jokes[Math.floor(Math.random() * jokes.length)]}`);
                    break;
                }
                
                case 'quote': {
                    const quotes = [
                        "🚚 *'Raste kitne bhi mushkil kyun na hon, ek sachha driver manzil tak gadi laga hi deta hai.'* - Transport Proverb",
                        "🌟 *'Your work is going to fill a large part of your life, and the only way to be truly satisfied is to do what you believe is great work.'* - Steve Jobs",
                        "🛣️ *'Behind every product you buy is a truck driver who drove hundreds of miles to deliver it. Respect the wheels.'* - GlobalUnido Legacy"
                    ];
                    await chat.sendMessage(`🌟 *INSPIRATIONAL DRIVER QUOTES:* \n\n${quotes[Math.floor(Math.random() * quotes.length)]}`);
                    break;
                }
                
                case 'trivia': {
                    const trivias = [
                        "❓ *TRIVIA QUESTION:* Which is the longest National Highway in India?\n👉 *Answer:* NH 44 (Runs from Srinagar to Kanyakumari, spanning 3,745 km! 🛣️)",
                        "❓ *TRIVIA QUESTION:* In which year was the first SMS text message sent?\n👉 *Answer:* 1992 (It read 'Merry Christmas' and was sent via Vodafone UK. 📱)"
                    ];
                    await chat.sendMessage(`⚡ *ZABIR TRIVIA BRAINTEASER:* \n\n${trivias[Math.floor(Math.random() * trivias.length)]}`);
                    break;
                }
                
                case 'stats': {
                    let systemStats = `📊 *${db.settings.botName.toUpperCase()} DIAGNOSTICS CONTROL* 🤖\n\n`;
                    systemStats += `👑 *Owner:* ${db.settings.ownerName}\n`;
                    systemStats += `📈 *Messages Received:* ${db.stats.messagesReceived}\n`;
                    systemStats += `📉 *Messages Delivered:* ${db.stats.messagesSent}\n`;
                    systemStats += `⚡ *Commands Run:* ${db.stats.commandsExecuted}\n`;
                    systemStats += `🌐 *Dashboard Control:* http://localhost:3000\n\n`;
                    systemStats += `_Zabir AI is healthy and running locally on Boss's laptop!_ 💻🏆`;
                    await chat.sendMessage(systemStats);
                    break;
                }
                
                default:
                    await msg.reply(`❌ Unknown command. Write \`${prefix}help\` to see the list of valid triggers.`);
            }
            return;
        }
        
        // Prevent outgoing bot messages (or non-command fromMe messages) from triggering auto-replies
        if (isFromMe) return;
        
        // --- 2. KEYWORD AUTO-REPLIES MONITORING ---
        const lowerBody = body.toLowerCase().trim();
        const matchedReply = db.autoReplies.find(r => lowerBody === r.trigger.toLowerCase());
        
        if (matchedReply) {
            const chat = await msg.getChat();
            await chat.sendMessage(matchedReply.reply);
            console.log(`[✔] Sent keyword auto-reply for trigger: "${matchedReply.trigger}"`);
            db.stats.messagesSent++;
            sharedContext.saveDb(db);
            sharedContext.broadcastWS('stats', db.stats);
            return;
        }
        
        // --- 3. PERSONAL ASSISTANT CHATBOT (NON-AI DETECT) ---
        const isDirectChat = !chat.isGroup;
        const startsWithZabir = lowerBody.startsWith('zabir') || lowerBody.includes('zabir');

        if (isOwner && (isDirectChat || startsWithZabir)) {
            let query = body;
            if (lowerBody.startsWith('zabir')) {
                query = body.substring(5).trim();
            }
            const lowerQuery = query.toLowerCase();

            // Special Command: What did you do just now?
            if (lowerQuery.includes('kya kiya') || lowerQuery.includes('recent') || lowerQuery.includes('status') || lowerQuery.includes('report')) {
                let response = `*नमस्ते सर! मैं आपका पर्सनल असिस्टेंट ज़ाबिर हूँ।* 🚚✨\n\n`;
                response += `📊 *बॉट वर्तमान स्थिति:* एक्टिव और रनिंग (Active & Running) locally on your laptop!\n`;
                response += `📁 *लोकल एक्सेल फाइल:* WhatsApp_Loads.xlsx पर सुरक्षित सेव हो रहा है।\n\n`;
                
                if (global.recentProcessedLoads.length === 0) {
                    response += `🔄 *हालिया गतिविधि:* अभी तक कोई नया लोड प्रोसेस नहीं हुआ है। मैं आपके एक्टिव चैनल्स की निगरानी कर रहा हूँ!`;
                } else {
                    response += `✅ *हाल ही में प्रोसेस किए गए लोड:* \n`;
                    global.recentProcessedLoads.slice(-5).reverse().forEach((load, idx) => {
                        response += `\n${idx + 1}. [${load.time}] - ${load.channel}\n📝 ${load.text.substring(0, 100)}...\n`;
                    });
                }
                
                await chat.sendMessage(response);
                db.stats.messagesSent++;
                sharedContext.saveDb(db);
                sharedContext.broadcastWS('stats', db.stats);
                return;
            }

            // Offline Personal Assistant Mode (Non-AI)
            const offlineResponse = `*नमस्ते सर! मैं आपका पर्सनल असिस्टेंट ज़ाबिर हूँ।* 🚚✨\n\n` +
                                    `AI फीचर्स को हटा दिया गया है। मैं यहाँ आपके सभी WhatsApp लोड को बिना किसी देरी (0ms latency) के तेज़ी से प्रोसेस करने के लिए पूरी तरह तैयार हूँ! 💪\n\n` +
                                    `📊 अगर आपको हालिया गतिविधि या रिपोर्ट देखनी है, तो आप *status* या *report* टाइप कर सकते हैं। धन्यवाद! 🙏`;
            await chat.sendMessage(offlineResponse);
            db.stats.messagesSent++;
            sharedContext.saveDb(db);
            sharedContext.broadcastWS('stats', db.stats);
            return;
        }

        // --- 4. AUTOMATED CARGO CHANNEL FORWARDING MODE ---
        let chatName = chat.name || "";
        const sourceChannels = db.settings.sourceChannels || [];
        const isFromMonitoredChannel = sourceChannels.some(ch => chatName.toLowerCase().includes(ch.toLowerCase()));

        if (isFromMonitoredChannel) {
            console.log(`[i] Message received from monitored channel: "${chatName}"`);
            
            // Balanced Load Detection Filter
            // 1. Ignore "khali gadi" (empty vehicles), spam, and fraud alerts
            const isSpamOrKhali = /(khali|empty|chor|fraud|scam|dhokha|good morning|hi|hello)/i.test(body);
            const hasBasicLoadWord = /(load|gadi|chahiye|require|booking|ton|mt|route|from|to|-|se|tak|transport|service|open|container|trailer|ft|feet|truck|tyre)/i.test(body);

            // Bypass filter if there's media (we rely on AI to figure out if media is a load)
            if (!mediaData && (isSpamOrKhali || !hasBasicLoadWord)) {
                console.log(`[i] Message filtered out (Not a valid load requirement or is 'gadi khali' / spam). Ignoring.`);
                return;
            }

            // Deduplication Filter: Ignore exact duplicate messages
            global.processedLoadSignatures = global.processedLoadSignatures || [];
            const signature = body.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (global.processedLoadSignatures.includes(signature)) {
                console.log(`[i] [DEDUPLICATION] Ignored duplicate message from channel "${chatName}".`);
                return;
            }

            const phoneMatch = body.match(/(\+?\d{1,4}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g);
            const emailMatch = body.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/g);
            
            const originalNumber = phoneMatch ? phoneMatch[0] : null;
            const originalEmail = emailMatch ? emailMatch[0] : null;

            console.log(`[+] Auto-processing load requirement from channel: "${chatName}"`);
            
            // Save signature to cache to prevent duplicate forwarding
            global.processedLoadSignatures.push(signature);
            if (global.processedLoadSignatures.length > 200) {
                global.processedLoadSignatures.shift();
            }

            // --- BARGAINING LOGIC ---
            // Check if price is mentioned (e.g., contains 'rs', 'inr', 'bhada', 'fare', or a number > 500 near 'to')
            const hasPriceKeywords = /\b(rs|inr|bhada|fare|price|rate|rupees|₹)\b/i.test(body);

            if (hasPriceKeywords) {
                // Price exists, process normally
                await processConfirmedLoad(chatName, originalNumber, originalEmail, body, body, false, mediaData);
                return;
            }

            // No price found. Start Auto-Bargain.
            console.log(`[i] No price found in load from ${chatName}. Starting auto-bargaining for 1 min...`);
            
            // Prioritize the number mentioned inside the text. If not present, use the message author/sender.
            let actualSenderWID = msg.author || msg.from;
            if (originalNumber) {
                const cleanedNum = originalNumber.replace(/\D/g, '');
                if (cleanedNum.length >= 10) {
                    actualSenderWID = cleanedNum + '@c.us';
                    // Check if it starts with country code, if not prepend 91 for India as fallback
                    if (cleanedNum.length === 10) {
                        actualSenderWID = '91' + cleanedNum + '@c.us';
                    }
                }
            }

            // Cannot send private messages to a channel/newsletter directly.
            if (actualSenderWID.includes('@newsletter')) {
                console.log(`[i] Cannot bargain with a Channel directly and no number found in text. Processing normally.`);
                await processConfirmedLoad(chatName, originalNumber, originalEmail, body, body, false, mediaData);
                return;
            }

            const actualSenderNumber = actualSenderWID.split('@')[0];

            // Setup state
            global.pendingBargains.set(actualSenderNumber, {
                originalChatName: chatName,
                originalNumber: originalNumber,
                originalEmail: originalEmail,
                body: body,
                lastPrice: null
            });

            // Send initial message
            try {
                // Send private message to the author asking for price
                const authorChat = await client.getChatById(actualSenderWID);
                await authorChat.sendMessage("Iska bhada kitna hai?");
                console.log(`[+] Asked ${actualSenderNumber} for price.`);
            } catch(e) {
                console.error(`[!] Could not send private bargain msg to ${actualSenderNumber}:`, e.message);
                // If we can't message them, just process normally
                global.pendingBargains.delete(actualSenderNumber);
                await processConfirmedLoad(chatName, originalNumber, originalEmail, body, body, false, mediaData);
                return;
            }

            // Set 1 minute timeout to conclude bargaining
            setTimeout(async () => {
                if (global.pendingBargains.has(actualSenderNumber)) {
                    console.log(`[i] 1-minute bargain timeout reached for ${actualSenderNumber}.`);
                    const state = global.pendingBargains.get(actualSenderNumber);
                    
                    let finalBody = state.body;
                    if (state.lastPrice) {
                        finalBody += `\n\n*Final Agreed Fare:* ₹${state.lastPrice}`;
                    } else {
                        finalBody += `\n\n*Rate:* Open for discussion`;
                    }

                    // Forward it now
                    await processConfirmedLoad(state.originalChatName, state.originalNumber, state.originalEmail, finalBody, finalBody, false, mediaData);
                    
                    // Clear state
                    global.pendingBargains.delete(actualSenderNumber);
                }
            }, 60000); // 60 seconds

            return;
        }

        // --- 5. UNKNOWN USER WELCOME + NAME CAPTURE ---
        if (!chat.isGroup && !isOwner) {
            global.welcomeSentUsers = global.welcomeSentUsers || new Set();
            global.awaitingNameUsers = global.awaitingNameUsers || new Set();
            
            const userPhone = msg.from; // e.g. 919876543210@c.us
            if (userPhone.includes('@newsletter') || userPhone.includes('@broadcast') || userPhone.includes('@g.us')) return;
            const contacts = loadContacts();
            
            // If we are waiting for their name reply
            if (global.awaitingNameUsers.has(userPhone)) {
                const nameGiven = body.trim();
                if (nameGiven.length >= 2 && nameGiven.length <= 50) {
                    // Save name to contacts.json
                    contacts[userPhone] = {
                        name: nameGiven,
                        phone: userPhone.split('@')[0],
                        savedAt: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
                    };
                    saveContacts(contacts);
                    global.awaitingNameUsers.delete(userPhone);
                    
                    console.log(`[✔] Saved contact name "${nameGiven}" for ${userPhone}`);
                    
                    const thankMsg = `✅ *धन्यवाद ${nameGiven} जी!* आपका नाम हमारे सिस्टम में सेव हो गया है। 🙏\n\nकिसी भी लोड या ट्रांसपोर्ट सेवा के लिए बेझिझक संपर्क करें। हम हमेशा आपकी सेवा में तैयार हैं! 🚚✨`;
                    await chat.sendMessage(thankMsg);
                    db.stats.messagesSent++;
                    sharedContext.saveDb(db);
                    sharedContext.broadcastWS('stats', db.stats);
                    return;
                }
            }
            
            // First time welcome message
            if (!global.welcomeSentUsers.has(userPhone)) {
                global.welcomeSentUsers.add(userPhone);
                global.awaitingNameUsers.add(userPhone);
                
                const savedName = contacts[userPhone] ? contacts[userPhone].name : null;
                const greeting = savedName ? `*नमस्ते ${savedName} जी!*` : `*नमस्ते! स्वागत है आपका!* 🙏`;
                
                let welcome = `${greeting}\n\n`;
                welcome += `आप *GLOBALUNIDO Logistics Pvt. Ltd.* के WhatsApp पर आए हैं।\n`;
                welcome += `हम पूरे भारत में Safe, Fast और Reliable Truck/Transport सेवाएं प्रदान करते हैं। 🚛🇮🇳\n\n`;
                welcome += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
                welcome += `📞 *Call / WhatsApp:* +91 ${ownerNumber}\n`;
                welcome += `📧 *Email:* ${ownerEmail}\n`;
                welcome += `━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                if (!savedName) {
                    welcome += `📝 क्या आप अपना *नाम* बता सकते हैं? (ताकि हम आपकी बेहतर सेवा कर सकें)`;
                } else {
                    welcome += `किसी भी लोड, ट्रांसपोर्ट, या रेट की जानकारी के लिए हमसे बात करें। हम तैयार हैं! 💪`;
                    global.awaitingNameUsers.delete(userPhone); // Already have name
                }
                
                await chat.sendMessage(welcome);
                db.stats.messagesSent++;
                sharedContext.saveDb(db);
                sharedContext.broadcastWS('stats', db.stats);
                console.log(`[✔] Welcome message sent to new user: ${userPhone}`);
                return;
            }
            
            // Returning user inquiry handling
            const inquiryKeywords = ['gadi chahiye', 'truck chahiye', 'vehicle chahiye', 'load chahiye', 'rate kya', 'kitna rate', 'transport chahiye', 'booking chahiye', 'need truck', 'need vehicle', 'load available', 'gadi milegi'];
            const isInquiry = inquiryKeywords.some(kw => lowerBody.includes(kw));
            
            if (isInquiry) {
                const savedContact = contacts[userPhone];
                const userName = savedContact ? savedContact.name : 'भाई साहब';
                console.log(`[+] Inquiry from ${userName} (${userPhone}): "${body.substring(0, 50)}"`);
                const parsed = parseLoadText(body);
                let fromText = parsed.fromPlace !== "Anywhere" ? parsed.fromPlace : "";
                let toText = parsed.toPlace !== "Anywhere" ? parsed.toPlace : "";
                let vehText = parsed.vehicleInfo !== "Any Truck Required" ? parsed.vehicleInfo : "";
                
                let reply = `*नमस्ते ${userName} जी! GLOBALUNIDO Logistics में आपका स्वागत है!* 🙏🚚\n\n`;
                if (fromText || toText || vehText) {
                    reply += `📍 *आपका रूट:* ${fromText ? fromText.toUpperCase() : '?'} ➡️ ${toText ? toText.toUpperCase() : '?'}\n`;
                    if (vehText) reply += `🚛 *गाड़ी:* ${vehText}\n`;
                    reply += `\nबेस्ट रेट और तुरंत Booking के लिए अभी Call करें:\n`;
                } else {
                    reply += `आपकी Transport जरूरत के लिए हम तैयार हैं!\nतुरंत Booking के लिए अभी Call करें:\n`;
                }
                reply += `📞 *+91 ${ownerNumber}*\n`;
                reply += `📧 ${ownerEmail}\n`;
                reply += `\n_हम आपको बेस्ट मार्केट रेट पर गारंटीड सर्विस देंगे! 😊_`;

                await chat.sendMessage(reply);
                db.stats.messagesSent++;
                sharedContext.saveDb(db);
                sharedContext.broadcastWS('stats', db.stats);
                console.log(`[✔] Inquiry reply sent to ${userName}.`);
            }
        }
    } catch (e) {
        console.error('[!] Error in processIncomingMessage:', e.message);
    }
}

// Startup Initialization Trigger
function initializeBot(ctx) {
    sharedContext = ctx;
    cleanSessionLocks();
    
    const MONGO_URI = process.env.MONGO_URI;
    const useLocalAuth = !MONGO_URI;

    if (useLocalAuth) {
        console.log('[i] MONGO_URI not found. Starting in LOCAL mode using LocalAuth...');
        sharedContext.setBotState('initializing', 'Launching Puppeteer and configuring background configurations...');
        
        const chromePath = getChromeExecutablePath();
        client = new Client({
            authStrategy: new LocalAuth({
                dataPath: path.join(__dirname, '..', '.wwebjs_auth')
            }),
            puppeteer: {
                headless: true,
                executablePath: chromePath || undefined,
                args: [
                    '--no-sandbox', 
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                ]
            }
        });

        setupEventListeners();
        
        console.log('[i] Starting WhatsApp Client...');
        client.initialize().then(() => {
            console.log('[✔] Local WhatsApp Bot client.initialize() completed!');
        }).catch(err => {
            console.error('[❌] Local startup failed:', err.message || err);
            sharedContext.setBotState('disconnected', `Startup failed: ${err.message}. Retrying...`);
        });

    } else {
        console.log('[i] MONGO_URI detected. Starting in CLOUD mode using RemoteAuth + MongoDB Atlas...');
        sharedContext.setBotState('initializing', 'Launching Puppeteer and connecting to MongoDB Cloud database...');
        
        mongoose.connect(MONGO_URI).then(() => {
            console.log('[✔] MongoDB Connected successfully!');
            const { MongoStore } = require('wwebjs-mongo');
            const store = new MongoStore({ mongoose: mongoose });
            
            const chromePath = getChromeExecutablePath();
            client = new Client({
                authStrategy: new RemoteAuth({
                    store: store,
                    backupSyncIntervalMs: 300000
                }),
                puppeteer: {
                    headless: true,
                    executablePath: chromePath || undefined,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu'
                    ]
                }
            });

            setupEventListeners();

            console.log('[i] Starting WhatsApp Client...');
            return client.initialize();
        }).then(() => {
            console.log('[✔] client.initialize() resolved!');
        }).catch(err => {
            console.error('[❌] Fatal startup error:', err.message || err);
            sharedContext.setBotState('disconnected', `Startup failed: ${err.message}`);
            process.exit(1);
        });
    }

    return {
        getClient: () => client,
        processConfirmedLoad,
        loadDrivers,
        saveDrivers
    };
}

module.exports = {
    initializeBot,
    parseLoadText,
    cleanMessageText,
    formatDeterministicGroupMessage
};
