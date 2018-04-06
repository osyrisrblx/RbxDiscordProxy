import express = require("express");
import request = require("request");
import fs = require("fs");
import bodyParser = require("body-parser");
import { format } from "util";

const MAX_QUEUE_SIZE = process.env.MAX_QUEUE_SIZE ? parseInt(process.env.MAX_QUEUE_SIZE) : 100;
const MAX_ERRORS = process.env.MAX_ERRORS ? parseInt(process.env.MAX_ERRORS) : 100;
const WEBHOOK_TEMPLATE = "https://discordapp.com/api/webhooks/%s/%s";
const DISCORD_PREFIX = "x-ratelimit-";
const DISCORD_LIMIT = DISCORD_PREFIX + "limit";
const DISCORD_REMAINING = DISCORD_PREFIX + "remaining";
const DISCORD_RESET = DISCORD_PREFIX + "reset";
const BANNED_FILE_PATH = "/banned.json";
const BANNED_NOTIFICATION_TEXT = `This webhook has been banned from the \`osyr.is\` Discord proxy server for violating Discord rate limits too often!
Please create a new webhook and change your code to reduce how many requests you send.
Contact \`Osyris#0001\` for further help if needed.`;

let rates: {
	[key: string]: {
		name?: string;
		token: string;
		limit: number;
		remaining: number;
		reset: number;
		errors: number;
		queue: string[];
	};
} = {};

let bannedHookIds: string[] = [];

function getRateData(hookId: string, hookToken: string) {
	let rateData = rates[hookId];
	if (!rateData) {
		rateData = {
			token: hookToken,
			limit: 0,
			remaining: 1,
			reset: -1,
			errors: 0,
			queue: []
		};
		rates[hookId] = rateData;
	}
	return rateData;
}

async function sendRequest(hookId: string, hookToken: string, payload: string) {
	let rateData = getRateData(hookId, hookToken);
	if (rateData.remaining > 0) {
		rateData.remaining--;
		request(format(WEBHOOK_TEMPLATE, hookId, hookToken), {
			method: "post",
			headers: {
				["content-type"]: "application/json"
			},
			body: payload
		}).on("response", res => {
			let reset = Number(res.headers[DISCORD_RESET]);
			let limit = Number(res.headers[DISCORD_LIMIT]);
			let remaining = Number(res.headers[DISCORD_REMAINING]);
			if (!isNaN(reset)) {
				rateData.reset = reset;
			}
			if (!isNaN(limit)) {
				rateData.limit = limit;
			}
			if (!isNaN(remaining)) {
				rateData.remaining = remaining;
			}
			if (res.statusCode == 429) {
				rateData.queue.push(payload);
			}
		});
	} else {
		rateData.queue.push(payload);
	}
}

// process queue
setInterval(() => {
	let time = Math.floor(Date.now() / 1000);
	let keys = Object.keys(rates);
	for (let i = 0; i < keys.length; i++) {
		let key = keys[i];
		let rateData = rates[key];
		if (rateData.reset !== -1 && time >= rateData.reset) {
			rateData.remaining = rateData.limit;
			rateData.reset = -1;
			for (let i = rateData.queue.length - 1; i >= 0; i--) {
				if (rateData.remaining > 0) {
					sendRequest(key, rateData.token, rateData.queue.splice(i, 1)[0]);
				}
			}
		}
	}
}, 1000);

const app = express();

app.use(bodyParser.text({ type: "*/*" }));

app.post("/api/webhooks/:hookId/:hookToken", (req, res) => {
	let hookId = req.params.hookId;
	let hookToken = req.params.hookToken;
	if (bannedHookIds.indexOf(hookId) == -1) {
		let rateData = getRateData(hookId, hookToken);
		if (rateData.queue.length >= MAX_QUEUE_SIZE) {
			rateData.errors++;
			if (rateData.errors >= MAX_ERRORS) {
				bannedHookIds.push(hookId);
				fs.writeFile(BANNED_FILE_PATH, JSON.stringify(bannedHookIds), "utf8", () => {});
				rateData.queue = [];
				sendRequest(
					hookId,
					hookToken,
					JSON.stringify({
						username: "Error",
						avatar_url: "https://i.imgur.com/zjyzJsb.png",
						content: BANNED_NOTIFICATION_TEXT
					})
				);
			}
		} else {
			sendRequest(hookId, hookToken, req.body);
		}
	}
	res.status(200).end();
});

function getBodyAsync(req: request.Request) {
	return new Promise<string>((resolve, reject) => {
		let body = "";
		req
			.on("data", chunk => (body += chunk.toString()))
			.on("end", () => resolve(body))
			.on("error", e => reject(e));
	});
}

interface Info {
	name?: string;
	queueSize?: number;
	errorCount?: number;
}

app.get("/", async (req, res) => {
	let result = {
		hooks: [] as Info[],
		banned: bannedHookIds
	};
	let ids = Object.keys(rates);
	for (let i = 0; i < ids.length; i++) {
		let hookId = ids[i];
		let data = rates[hookId];
		let info: Info = {};
		if (data.queue.length > 0) {
			info.queueSize = data.queue.length;
		}
		if (data.errors > 0) {
			info.errorCount = data.errors;
		}
		if (!data.name) {
			try {
				data.name = JSON.parse(await getBodyAsync(request(format(WEBHOOK_TEMPLATE, hookId, data.token)))).name;
			} catch (e) {}
		}
		if (data.name) {
			info.name = data.name;
		}
		result.hooks.push(info);
	}
	res.json(result).end();
});

if (fs.existsSync(BANNED_FILE_PATH)) {
	console.log("Importing banned.json..");
	try {
		bannedHookIds = JSON.parse(fs.readFileSync(BANNED_FILE_PATH, "utf8"));
		console.log("Imported banned.json!");
	} catch (e) {}
}

console.log("Starting server..");
app.listen(80, () => console.log("Started server!"));
