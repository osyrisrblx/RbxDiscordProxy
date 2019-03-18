import ua = require("universal-analytics");

const sessions = new Map<string, ua.Visitor>();

const GA_ID = process.env.GA_ID || "";

function getSession(hookId: string) {
	let session = sessions.get(hookId);
	if (!session) {
		session = ua(GA_ID!, { uid: hookId });
		sessions.set(hookId, session);
	}
	return session;
}

function trackEvent(hookId: string, category: string, action: string) {
	if (GA_ID !== "") {
		console.log("trackEvent", hookId, category, action)
		getSession(hookId)
			.event(category, action)
			.send();
	}
}

export function trackRequestFailed(hookId: string) {
	trackEvent(hookId, "Request", "Failed");
}

export function trackRequestSuccess(hookId: string) {
	trackEvent(hookId, "Request", "Success");
}

export function trackUserBanned(hookId: string) {
	trackEvent(hookId, "User", "Banned");
}
