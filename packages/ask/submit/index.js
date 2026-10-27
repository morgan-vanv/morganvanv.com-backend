const fetch = require('node-fetch');
const { problem, discordPayload, publishConfig } = require('./embed');

async function main(args) {
    // 1. CORS Preflight Handling for GitHub Pages
    if (args.__ow_method === "options") {
        return {
            statusCode: 204
        };
    }

    // Only the site's POST is a submission. Web actions also take GET query parameters, so without
    // this a plain link or <img src="…?question=…"> on any page would post to Discord from its visitors.
    if (args.__ow_method && args.__ow_method !== "post") {
        return {
            statusCode: 405,
            headers: { 'Allow': 'POST, OPTIONS', 'Content-Type': 'application/json' },
            body: { error: "Method not allowed." }
        };
    }

    // 2. Honeypot Spam Mitigation
    if (typeof args.username_honey === "string" && args.username_honey.trim() !== "") {
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

    // 4. Discord Payload Construction (a title and colour per kind, and a "Publish as PR" link
    //    when PUBLISH_URL and PUBLISH_SECRET are set; see embed.js)
    const payload = discordPayload(args, new Date(), publishConfig(process.env));

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

