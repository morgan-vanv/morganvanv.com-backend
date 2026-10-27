const fetch = require('node-fetch');
const { problem, discordPayload } = require('./embed');

async function main(args) {
    // 1. CORS Preflight Handling for GitHub Pages
    if (args.__ow_method === "options") {
        return {
            statusCode: 204
        };
    }

    // 2. Honeypot Spam Mitigation
    if (args.username_honey && args.username_honey.trim() !== "") {
        return { 
            statusCode: 200, 
            headers: { 'Content-Type': 'application/json' },
            body: { success: true, message: "Submission received." } 
        };
    }

    // 3. Input Validation
    const error = problem(args);
    if (error) {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: { error }
        };
    }

    // 4. Discord Payload Construction (a title and colour per kind; see embed.js)
    const payload = discordPayload(args);

    // 5. Dispatch to Discord
    try {
        const response = await fetch(process.env.DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`Discord responded with status ${response.status}`);
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: { success: true, message: "Sent successfully!" }
        };

    } catch (error) {
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: { error: "Internal server error failing to dispatch message." }
        };
    }
}

exports.main = main;

