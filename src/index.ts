import express = require("express");
import request = require("request");
import bodyParser = require("body-parser");
import { format } from "util";

const MAX_QUEUE_SIZE = process.env.MAX_QUEUE_SIZE || 100;

const WEBHOOK_TEMPLATE = "https://discordapp.com/api/webhooks/%s/%s";
const DISCORD_PREFIX = "x-ratelimit-";
const DISCORD_LIMIT = DISCORD_PREFIX + "limit";
const DISCORD_REMAINING = DISCORD_PREFIX + "remaining";
const DISCORD_RESET = DISCORD_PREFIX + "reset";

let rates: {
	[key: string]: {
		token: string;
		limit: number;
		remaining: number;
		reset: number;
		errors: number;
		queue: string[];
	}
} = {};

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
			body: payload,
		})
			.on("response", res => {
				let reset = Number(res.headers[DISCORD_RESET]);
				let limit = Number(res.headers[DISCORD_LIMIT]);
				let remaining = Number(res.headers[DISCORD_REMAINING]);
				if (!isNaN(reset)) { rateData.reset = reset; }
				if (!isNaN(limit)) { rateData.limit = limit; }
				if (!isNaN(remaining)) { rateData.remaining = remaining; }
				if (res.statusCode == 429) {
					rateData.queue.push(payload);
				}
			});
	} else {
		rateData.queue.push(payload);
	}
}

setInterval(() => {
	let time = Math.floor(Date.now()/1000);
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
	let rateData = getRateData(hookId, hookToken);
	if (rateData.queue.length > MAX_QUEUE_SIZE) {
		res
			.status(400)
			.end("Error: Too many requests!");
		rateData.errors++;
	} else {
		res
			.status(200)
			.end();
		sendRequest(hookId, hookToken, req.body);
	}
});

function getBodyAsync(req: request.Request) {
	return new Promise<string>(
		(resolve, reject) => {
			let body = "";
			req
				.on("data", chunk => body += chunk.toString())
				.on("end", () => resolve(body))
				.on("error", e => reject(e));
		}
	);
}

app.get("/", async (req, res) => {
	let result: {
		name: string,
		queueSize: number,
		errorCount: number
	}[] = [];
	let keys = Object.keys(rates);
	for (let i = 0; i < keys.length; i++) {
		let key = keys[i];
		let data = rates[key];
		let name = "UNKNOWN";
		try {
			name = JSON.parse(await getBodyAsync(request(format(WEBHOOK_TEMPLATE, key, data.token)))).name;
		} catch (e) { }
		result.push({
			name: name,
			queueSize: data.queue.length,
			errorCount: data.errors,
		});
	}
	res.json(result);
	res.end();
});

app.listen(80);