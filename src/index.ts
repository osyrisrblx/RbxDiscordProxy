import path = require("path");
import express = require("express");
import request = require("request");
import fs = require("fs");
import bodyParser = require("body-parser");
import { format } from "util";
import { trackRequestFailed, trackRequestSuccess, trackUserBanned } from "./Analytics";

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
const BANNED_NOTIFICATION_TEXT = fs.readFileSync(path.join(__dirname, "../banned.txt")).toString();
const BANNED_JSON = JSON.stringify({
	username: BANNED_USERNAME,
	avatar_url: BANNED_AVATAR_URL,
	content: BANNED_NOTIFICATION_TEXT
});

const ROBLOX_GAME_URL_TEMPLATE = "https://www.roblox.com/games/%d/redirect";

const DEPRECATION_SEEN = new Set<string>();
const DEPRECATION_JSON = JSON.stringify({
	username: "Notice",
	avatar_url: "https://www.freeiconspng.com/uploads/orange-warning-icon-3.png",
	content: fs.readFileSync(path.join(__dirname, "../deprecated.txt")).toString(),
});

interface HookData {
	name?: string;
	placeId?: string;
	token: string;
	limit: number;
	remaining: number;
	reset: number;
	errors: number;
	queue: string[];
}

const data = new Map<string, HookData>();

const MAX_REQUEST_HISTORY = 1000;
interface Request {
	time: number;
	placeId: string;
	id: string;
	payloadLength: number;
}
const requestHistory = new Array<Request>();

let bannedHookIds = new Array<string>();

function getOrSetDefault<K, V>(map: Map<K, V>, key: K, defaultValue: V) {
	let value = map.get(key);
	if (!value) {
		value = defaultValue;
		map.set(key, value);
	}
	return value;
}

async function sendRequest(hookId: string, hookToken: string, payload: string) {
	let hookData = data.get(hookId)!;
	if (hookData.remaining > 0) {
		hookData.remaining--;
		request(format(WEBHOOK_TEMPLATE, hookId, hookToken), {
			method: "post",
			headers: {
				["content-type"]: "application/json"
			},
			body: payload
		})
			.on("error", e => {
				console.log("error", e);
			})
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

				if (res.statusCode === 204) {
					trackRequestSuccess(hookId);
				} else {
					trackRequestFailed(hookId);
				}

				if (res.statusCode === 429) {
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
	for (const [hookId, hookData] of data.entries()) {
		if (hookData.reset !== -1 && time >= hookData.reset) {
			hookData.remaining = hookData.limit;
			hookData.reset = -1;
			for (let i = hookData.queue.length - 1; i >= 0; i--) {
				if (hookData.remaining > 0) {
					sendRequest(hookId, hookData.token, hookData.queue.splice(i, 1)[0]);
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

	requestHistory.unshift({
		time: Math.floor(Date.now() / 1000),
		id: hookId,
		placeId: req.headers["roblox-id"] as string,
		payloadLength: req.body.length
	});
	if (requestHistory.length > MAX_REQUEST_HISTORY) {
		requestHistory.pop();
	}

	if (!DEPRECATION_SEEN.has(hookId)) {
		DEPRECATION_SEEN.add(hookId);
		sendRequest(hookId, hookToken, DEPRECATION_JSON);
	}

	if (bannedHookIds.indexOf(hookId) == -1) {
		const hookData = getOrSetDefault(data, hookId, {
			token: hookToken,
			limit: 0,
			remaining: 1,
			reset: -1,
			errors: 0,
			queue: []
		});
		let placeId = req.headers["roblox-id"];
		if (placeId && typeof placeId == "string") {
			hookData.placeId = placeId;
		}
		if (hookData.queue.length >= MAX_QUEUE_SIZE) {
			hookData.errors++;
			if (hookData.errors >= MAX_ERRORS) {
				bannedHookIds.push(hookId);
				fs.writeFile(BANNED_FILE_PATH, JSON.stringify(bannedHookIds), "utf8", () => {});
				hookData.queue = [];
				hookData.remaining = 1;
				sendRequest(hookId, hookToken, BANNED_JSON);
				trackUserBanned(hookId);
			}
		} else {
			sendRequest(hookId, hookToken, req.body);
		}
	}
});

function getBodyAsync(req: request.Request) {
	return new Promise<string>((resolve, reject) => {
		let body = "";
		req.on("data", chunk => (body += chunk.toString()))
			.on("end", () => resolve(body))
			.on("error", e => reject(e));
	});
}

interface Info {
	id?: string;
	name?: string;
	link?: string;
	queueSize?: number;
	errorCount?: number;
	limit?: number;
	remaining?: number;
	reset?: number;
}

const pkgJson = require("./../package.json");
app.get("/", async (req, res) => {
	let result = {
		time: Math.floor(Date.now() / 1000),
		version: pkgJson.version,
		hooks: [] as Info[]
	};
	for (const [hookId, hookData] of data.entries()) {
		let info: Info = {};
		info.id = hookId;
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

		info.reset = hookData.reset;
		info.limit = hookData.limit;
		info.remaining = hookData.remaining;

		result.hooks.push(info);
	}
	res.json(result).end();
});

app.get("/api/webhooks/:hookId", (req, res) => {
	const hookId = req.params.hookId;
	const hookData = data.get(hookId);
	if (hookData) {
		res.json({
			name: hookData.name,
			placeId: hookData.placeId,
			limit: hookData.limit,
			remaining: hookData.remaining,
			reset: hookData.reset,
		}).end();
	} else {
		res.status(404).end();
	}
});

if (fs.existsSync(BANNED_FILE_PATH)) {
	console.log("Importing banned.json..");
	try {
		bannedHookIds = JSON.parse(fs.readFileSync(BANNED_FILE_PATH, "utf8"));
		console.log("Imported banned.json!");
	} catch (e) {}
}

console.log("Starting server.. [DEPREACTED]");
app.listen(80, () => console.log("Started server! [DEPREACTED]"));
