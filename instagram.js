const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const isWin = process.platform === "win32";
const SESSION_DIR = path.join(__dirname, 'instagram_session');

const delay = ms => new Promise(res => setTimeout(res, ms));

// Launch visible browser to let user login to Instagram once
async function launchLoginWindow() {
    console.log('[i] Launching Chromium browser to login to Instagram. Please login in the opened window...');
    try {
        const browser = await puppeteer.launch({
            headless: false,
            userDataDir: SESSION_DIR,
            defaultViewport: { width: 390, height: 844, isMobile: true },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
            ]
        });
        
        const page = await browser.newPage();
        await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('[✔] Instagram login page opened. Please complete login in the browser window.');
        
        // Watch for window close
        const timer = setInterval(async () => {
            try {
                const pages = await browser.pages();
                if (pages.length === 0) {
                    clearInterval(timer);
                    console.log('[✔] Instagram login window closed. Session saved successfully!');
                }
            } catch (e) {
                clearInterval(timer);
                console.log('[✔] Instagram session saved!');
            }
        }, 1500);
    } catch (err) {
        console.error('[!] Failed to open Instagram login browser:', err.message);
        throw err;
    }
}

// Automatic Instagram Poster using saved session (Supports Images & Videos!)
async function postToInstagram(filePath, captionText) {
    let browser;
    try {
        const isVideo = filePath.toLowerCase().endsWith('.mp4');
        console.log(`[i] Starting Instagram auto-post for ${isVideo ? 'Video' : 'Image'}...`);
        
        browser = await puppeteer.launch({
            headless: true, // run silently in the background
            userDataDir: SESSION_DIR,
            defaultViewport: { width: 1080, height: 1080 },
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Mobile/15E148 Safari/604.1',
                '--disable-blink-features=AutomationControlled' // Bypass bot detection!
            ]
        });

        const page = await browser.newPage();
        
        // Stealth Webdriver Redefinition
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });
        await delay(5000);

        // Bypass "Not Now" / "Save Info" prompts in mobile view
        try {
            const notNowButtons = await page.$x('//button[contains(text(), "Not Now")]');
            for (const btn of notNowButtons) {
                await btn.click();
                await delay(2000);
            }
        } catch (e) {}

        try {
            const notNowDivs = await page.$x('//div[contains(text(), "Not Now")]');
            for (const div of notNowDivs) {
                await div.click();
                await delay(2000);
            }
        } catch (e) {}

        // Wait to verify if we are logged in
        let loggedIn = false;
        const checkSelectors = ['svg[aria-label="New Post"]', 'svg[aria-label="New post"]', 'svg[aria-label="Create"]', 'input[type="file"]'];
        for (const selector of checkSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 3000 });
                loggedIn = true;
                break;
            } catch (e) {}
        }

        if (!loggedIn) {
            const loginInput = await page.$('input[name="username"]');
            if (loginInput) {
                throw new Error('Not logged in to Instagram! Please run Login_Instagram.bat to log in first.');
            }
        }

        console.log('[+] Instagram session confirmed. Uploading file directly...');

        // Directly set path to input file (100% stable bypass!)
        const fileInputSelector = 'input[type="file"]';
        await page.waitForSelector(fileInputSelector, { timeout: 15000 });
        const inputUploadHandle = await page.$(fileInputSelector);
        await inputUploadHandle.uploadFile(filePath);
        console.log(`[✔] File successfully uploaded to post creator.`);

        // Wait for file parsing and loading (longer delay for videos)
        await delay(isVideo ? 8000 : 4000);

        // Helper to click elements using XPath
        async function clickXPath(xpath) {
            const elements = await page.$x(xpath);
            if (elements.length > 0) {
                await elements[0].click();
                return true;
            }
            return false;
        }

        // Adaptive "Next" wizard step clicker
        console.log('[+] Processing posting wizard screens...');
        for (let i = 0; i < 3; i++) {
            await delay(4000);
            let nextClicked = await clickXPath('//button[contains(text(), "Next")]') || 
                              await clickXPath('//div[contains(text(), "Next")]');
            if (nextClicked) {
                console.log(`[+] Clicked Next button on wizard step ${i+1}`);
            } else {
                break;
            }
        }

        await delay(3000);

        // Write the Caption
        const captionSelector = 'textarea[aria-label="Write a caption..."]';
        await page.waitForSelector(captionSelector, { timeout: 10000 });
        await page.focus(captionSelector);
        await page.keyboard.type(captionText);
        console.log('[+] Caption successfully typed.');

        await delay(3000);

        // Click the Share button
        let clickedShare = await clickXPath('//button[contains(text(), "Share")]') || 
                           await clickXPath('//div[contains(text(), "Share")]');
        if (clickedShare) {
            console.log('[+] Clicked Share button.');
        }

        // Wait for upload and publication to complete
        await delay(isVideo ? 15000 : 8000);
        console.log('[✔] Cargo post published successfully on Instagram!');
    } catch (e) {
        console.error('[!] Instagram Auto-Post Failed:', e.message);
    } finally {
        if (browser) await browser.close();
    }
}

// Automatic Instagram Story Poster using saved session (Supports Images & Videos!)
async function postToInstagramStory(filePath) {
    let browser;
    try {
        const isVideo = filePath.toLowerCase().endsWith('.mp4');
        console.log(`[i] Starting Instagram Story auto-post for ${isVideo ? 'Video' : 'Image'}...`);
        
        browser = await puppeteer.launch({
            headless: true,
            userDataDir: SESSION_DIR,
            defaultViewport: { width: 1080, height: 1920 }, // Vertical viewport for stories!
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Mobile/15E148 Safari/604.1',
                '--disable-blink-features=AutomationControlled' // Bypass bot detection!
            ]
        });

        const page = await browser.newPage();
        
        // Stealth Webdriver Redefinition
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });
        await delay(5000);

        // Bypass "Not Now" / "Save Info" prompts in mobile view
        try {
            const notNowButtons = await page.$x('//button[contains(text(), "Not Now")]');
            for (const btn of notNowButtons) {
                await btn.click();
                await delay(2000);
            }
        } catch (e) {}

        try {
            const notNowDivs = await page.$x('//div[contains(text(), "Not Now")]');
            for (const div of notNowDivs) {
                await div.click();
                await delay(2000);
            }
        } catch (e) {}

        // Wait to verify login
        let loggedIn = false;
        const checkSelectors = ['svg[aria-label="New Post"]', 'svg[aria-label="New post"]', 'svg[aria-label="Create"]', 'input[type="file"]'];
        for (const selector of checkSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 3000 });
                loggedIn = true;
                break;
            } catch (e) {}
        }

        if (!loggedIn) {
            const loginInput = await page.$('input[name="username"]');
            if (loginInput) {
                throw new Error('Not logged in to Instagram! Story post aborted.');
            }
        }

        console.log('[+] Instagram session confirmed. Direct navigating to story editor...');
        
        // Direct navigate to mobile story creator (no click required!)
        await page.goto('https://www.instagram.com/create/story/', { waitUntil: 'networkidle2' });

        await delay(4000);

        // Upload to the file input
        const fileInputSelector = 'input[type="file"]';
        await page.waitForSelector(fileInputSelector, { timeout: 10000 });
        const inputUploadHandle = await page.$(fileInputSelector);
        await inputUploadHandle.uploadFile(filePath);
        console.log(`[+] Story file uploaded successfully.`);

        await delay(isVideo ? 8000 : 4000);

        // Click "Add to your story" button
        let clickedShare = await clickXPath('//span[contains(text(), "Add to your story")]') ||
                           await clickXPath('//div[contains(text(), "Add to your story")]') ||
                           await clickXPath('//button[contains(text(), "Add to your story")]') ||
                           await clickXPath('//span[contains(text(), "Share to story")]') ||
                           await clickXPath('//button[contains(text(), "Share")]') ||
                           await clickXPath('//div[contains(text(), "Share")]');

        if (clickedShare) {
            console.log('[+] Clicked "Add to your story" share button.');
        }

        await delay(isVideo ? 15000 : 8000);
        console.log('[✔] Cargo post published successfully on Instagram Story!');
    } catch (e) {
        console.error('[!] Instagram Story Auto-Post Failed:', e.message);
    } finally {
        if (browser) await browser.close();
    }
}

// Send confirmed load message directly to Instagram DM Group
async function sendToInstagramGroup(groupName, messageText) {
    let browser;
    try {
        console.log(`[i] Sending load notification to Instagram DM Group "${groupName}"...`);
        browser = await puppeteer.launch({
            headless: true,
            userDataDir: SESSION_DIR,
            defaultViewport: { width: 1200, height: 800 }, // Desktop view is extremely stable for DM searches!
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        
        // Go to direct messages inbox
        await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'networkidle2' });
        await delay(5000);

        // Wait to verify we are logged in
        try {
            await page.waitForSelector('input[placeholder="Search"]', { timeout: 10000 });
        } catch (e) {
            // Check if there is a "Not Now" button for notifications and click it
            try {
                const notNowBtn = await page.$x('//button[contains(text(), "Not Now")]');
                if (notNowBtn.length > 0) {
                    await notNowBtn[0].click();
                    await delay(3000);
                }
            } catch (err) {}
        }

        // Search for the group name in the inbox list or via the Search box
        let groupSelected = false;
        
        // Strategy A: Scan existing inbox chats
        try {
            const chatElements = await page.$x(`//span[contains(text(), "${groupName}")]`);
            if (chatElements.length > 0) {
                await chatElements[0].click();
                groupSelected = true;
                console.log(`[+] Found and opened active Instagram DM group: "${groupName}"`);
            }
        } catch (e) {}

        // Strategy B: Use Direct Search if not in recent chats
        if (!groupSelected) {
            console.log(`[i] DM group not in recent chats. Searching via Search Box...`);
            // Click Search input
            const searchSelector = 'input[placeholder="Search"]';
            try {
                await page.waitForSelector(searchSelector, { timeout: 5000 });
                await page.focus(searchSelector);
                await page.keyboard.type(groupName);
                await delay(4000);

                // Click the first matching result
                const resultXPath = `//span[contains(text(), "${groupName}")]`;
                const searchResults = await page.$x(resultXPath);
                if (searchResults.length > 0) {
                    await searchResults[0].click();
                    groupSelected = true;
                    console.log(`[+] Group selected from search results.`);
                }
            } catch (searchErr) {
                console.error('[!] Failed during DM search:', searchErr.message);
            }
        }

        await delay(3000);

        if (groupSelected) {
            // Find message textbox and send
            const textBoxSelectors = [
                'textarea[placeholder="Message..."]',
                'div[role="textbox"]',
                'textarea'
            ];

            let typed = false;
            for (const selector of textBoxSelectors) {
                try {
                    await page.waitForSelector(selector, { timeout: 5000 });
                    await page.focus(selector);
                    await page.keyboard.type(messageText);
                    typed = true;
                    break;
                } catch (e) {}
            }

            if (typed) {
                await delay(1000);
                // Press Enter to send!
                await page.keyboard.press('Enter');
                console.log(`[✔] Message successfully sent to Instagram group "${groupName}"!`);
                await delay(3000); // Wait to ensure delivery
            } else {
                console.error('[!] Could not find text box to type DM message.');
            }
        } else {
            console.error(`[!] Could not find Instagram group named "${groupName}".`);
        }
    } catch (e) {
        console.error('[!] Instagram DM Group Forwarding Failed:', e.message);
    } finally {
        if (browser) await browser.close();
    }
}

// CLI Mode check
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args[0] === 'login') {
        launchLoginWindow();
    }
}

module.exports = { postToInstagram, postToInstagramStory, sendToInstagramGroup, launchLoginWindow };
