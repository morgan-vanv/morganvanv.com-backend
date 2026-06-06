const fetch = require('node-fetch');

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
    const userQuestion = args.question;
    if (!userQuestion || userQuestion.trim() === "") {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: { error: "Question field cannot be empty." }
        };
    }

    // 4. Discord Payload Construction
    const discordPayload = {
        embeds: [{
            title: "📬 New Anonymous Submission",
            description: userQuestion.trim(),
            color: 5814783,
            timestamp: new Date().toISOString()
        }]
    };

    // 5. Dispatch to Discord
    try {
        const response = await fetch(process.env.DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(discordPayload)
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

