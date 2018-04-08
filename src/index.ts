import express = require("express");
import request = require("request");
import fs = require("fs");
import bodyParser = require("body-parser");
import { format } from "util";

const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE || "100");
const MAX_ERRORS = parseInt(process.env.MAX_ERRORS || "100");

const WEBHOOK_TEMPLATE = "https://discordapp.com/api/webhooks/%s/%s";
const DISCORD_PREFIX = "x-ratelimit-";
const DISCORD_LIMIT = DISCORD_PREFIX + "limit";
const DISCORD_REMAINING = DISCORD_PREFIX + "remaining";
const DISCORD_RESET = DISCORD_PREFIX + "reset";

const BANNED_FILE_PATH = "/banned.json";
const BANNED_USERNAME = "Error";
const BANNED_AVATAR_URL = "https://i.imgur.com/zjyzJsb.png";
const BANNED_NOTIFICATION_TEXT = `This webhook has been banned from the \`osyr.is\` Discord proxy server for violating Discord rate limits too often!
Please create a new webhook and change your code to reduce how many requests you send.
Contact \`Osyris#0001\` for further help if needed.`;
const BANNED_JSON = JSON.stringify({
	username: BANNED_USERNAME,
	avatar_url: BANNED_AVATAR_URL,
	content: BANNED_NOTIFICATION_TEXT
});

const ROBLOX_GAME_URL_TEMPLATE = "https://www.roblox.com/games/%d/redirect";

let data: {
	[key: string]: {
		name?: string;
		placeId?: string;
		token: string;
		limit: number;
		remaining: number;
		reset: number;
		errors: number;
		queue: string[];
	};
} = {};

let bannedHookIds: string[] = [];

function getHookData(hookId: string, hookToken: string) {
	let hookData = data[hookId];
	if (!hookData) {
		hookData = {
			token: hookToken,
			limit: 0,
			remaining: 1,
			reset: -1,
			errors: 0,
			queue: []
		};
		data[hookId] = hookData;
	}
	return hookData;
}

async function sendRequest(hookId: string, hookToken: string, payload: string) {
	let hookData = getHookData(hookId, hookToken);
	if (hookData.remaining > 0) {
		hookData.remaining--;
		request(format(WEBHOOK_TEMPLATE, hookId, hookToken), {
			method: "post",
			headers: {
				["content-type"]: "application/json"
			},
			body: payload
		})
			.on("error", e => hookData.queue.push(payload)) // could this duplicate messages?
			.on("response", res => {
				let reset = Number(res.headers[DISCORD_RESET]);
				let limit = Number(res.headers[DISCORD_LIMIT]);
				let remaining = Number(res.headers[DISCORD_REMAINING]);
				if (!isNaN(reset)) {
					hookData.reset = reset;
				}
				if (!isNaN(limit)) {
					hookData.limit = limit;
				}
				if (!isNaN(remaining)) {
					hookData.remaining = remaining;
				}
				if (res.statusCode == 429) {
					hookData.queue.push(payload);
				}
			});
	} else {
		hookData.queue.push(payload);
	}
}

// process queue
setInterval(() => {
	let time = Math.floor(Date.now() / 1000);
	let keys = Object.keys(data);
	for (let i = 0; i < keys.length; i++) {
		let key = keys[i];
		let hookData = data[key];
		if (hookData.reset !== -1 && time >= hookData.reset) {
			hookData.remaining = hookData.limit;
			hookData.reset = -1;
			for (let i = hookData.queue.length - 1; i >= 0; i--) {
				if (hookData.remaining > 0) {
					sendRequest(key, hookData.token, hookData.queue.splice(i, 1)[0]);
				}
			}
		}
	}
}, 1000);

const app = express();

app.use(bodyParser.text({ type: "*/*" }));

app.post("/api/webhooks/:hookId/:hookToken", (req, res) => {
	res.status(200).end();
	let hookId = req.params.hookId;
	let hookToken = req.params.hookToken;
	if (bannedHookIds.indexOf(hookId) == -1) {
		let hookData = getHookData(hookId, hookToken);
		if (!hookData.placeId) {
			let placeId = req.headers["roblox-id"];
			if (placeId && typeof placeId == "string") {
				hookData.placeId = placeId;
			}
		}
		if (hookData.queue.length >= MAX_QUEUE_SIZE) {
			hookData.errors++;
			if (hookData.errors >= MAX_ERRORS) {
				bannedHookIds.push(hookId);
				fs.writeFile(BANNED_FILE_PATH, JSON.stringify(bannedHookIds), "utf8", () => {});
				hookData.queue = [];
				sendRequest(hookId, hookToken, BANNED_JSON);
			}
		} else {
			sendRequest(hookId, hookToken, req.body);
		}
	}
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
	link?: string;
	queueSize?: number;
	errorCount?: number;
}

app.get("/", async (req, res) => {
	let result = {
		hooks: [] as Info[],
		banned: bannedHookIds
	};
	let ids = Object.keys(data);
	for (let i = 0; i < ids.length; i++) {
		let hookId = ids[i];
		let hookData = data[hookId];
		let info: Info = {};
		if (!hookData.name) {
			try {
				hookData.name = JSON.parse(
					await getBodyAsync(request(format(WEBHOOK_TEMPLATE, hookId, hookData.token)))
				).name;
			} catch (e) {}
		}
		info.name = hookData.name;
		if (hookData.placeId) {
			info.link = format(ROBLOX_GAME_URL_TEMPLATE, hookData.placeId);
		}
		if (hookData.queue.length > 0) {
			info.queueSize = hookData.queue.length;
		}
		if (hookData.errors > 0) {
			info.errorCount = hookData.errors;
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
