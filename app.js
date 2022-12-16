/*******************
 * Library Imports *
 *******************/

import 'sqlite3'
import _ from 'lodash'
import colors from 'chalk'
import dotenv from 'dotenv'
import sqlite3 from 'sqlite3'
import TwitchJs from 'twitch-js'

// Dotenv initialization
dotenv.config()

// Sqlite3 initialization
const db = new sqlite3.Database('sqlite3_db');
db.run('CREATE TABLE chat_user_stats (Channel TEXT, UserName TEXT UNIQUE, MessageCount INT)', VOID_CALLBACK);


/*********************
 * Global Properties *
 *********************/

// Toggle ability to send real messages to Twitch channels
const DRY_RUN = false;

// Configure hype parameters
const HYPE_MIN_MSG_LEN = 1,
    HYPE_MAX_MSG_LEN = 200,
    HYPE_MAX_QUEUE_LEN = 8,
    HYPE_THRESHOLD = 3,
    HYPE_THROTTLE = 20000,
    HYPE_DEQUEUE_TIMER = HYPE_THROTTLE * 2,
    MSG_SEND_DELAY = 150,
    HYPE_USER_IGNORE_LIST = ['nightbot'];

const TWITCH_PREFERENCES = {
    channels: [
        'squishy_life',
        'northernlion'
    ],
    credentials: {
        username: `${process.env.TWITCH_USERNAME}`,
        token: `${process.env.TWITCH_PASSWORD}`
    }
};

// Regex for detecting a URI
const REGEX_CONTAINS_URI = new RegExp('(http|ftp|https):\/\/([\w_-]+(?:.[w_-]+)+)([\w.,@?^=%&:\/~+#-]*[\w@?^=%&\/~+#-])');

let messageQueues = {};


/******************
 * TwitchJS Setup *
 ******************/

// Create an instance of TwitchJS.
const chat = new TwitchJs.Chat({
    username: TWITCH_PREFERENCES.credentials.username,
    token: TWITCH_PREFERENCES.credentials.token,
    log: {level: 'error'}
});

// Extends TwitchJS functionality with addition of a limiter to queue message sending processes
chat.say = limiter((msg, channel) => {
    if (DRY_RUN) {
        console.log(`${colors.gray(getFormattedTime())} ${msg} -- (DRY RUN ENABLED)`);
        return;
    }

    setTimeout(() => {
        chat.send(`PRIVMSG #${channel} :${msg}`)
    }, MSG_SEND_DELAY);
}, 1500);


/********************
 * Helper Functions *
 ********************/

/**
 * Returns the current time as a string, formatted with hours, minutes, seconds, and period.
 *
 * @example "[2:47:10 AM]"
 * @returns {string}
 */
const getFormattedTime = () =>
    `[${new Date().toLocaleString('en-US', {hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true})}]`

/**
 * Create a queue of `fn` calls and execute them in order after `wait` milliseconds.
 *
 * @param fn {function}
 * @param wait {int}
 * @returns {function(): void}
 */
function limiter(fn, wait) {
    let isCalled = false,
        calls = [];

    const caller = function () {
        if (calls.length && !isCalled) {
            isCalled = true;
            calls.shift().call();
            setTimeout(function () {
                isCalled = false;
                caller()
            }, wait)
        }
    };

    return function () {
        calls.push(fn.bind(this, ...arguments));
        caller()
    }
}

/**
 * An empty function for callback placeholders.
 *
 * @returns {null}
 * @constructor
 */
function VOID_CALLBACK() {
    return null;
}


/******************************
 * Message Handling Functions *
 ******************************/

/**
 * Send a message to participate in the hype.
 *
 * @param channel
 * @param message
 */
function sendHypeMessage(channel, message) {
    recordUserChatStats(channel, TWITCH_PREFERENCES.credentials.username);

    console.log(`${colors.gray(getFormattedTime())} '${channel}': "${message}".`);
    chat.say(message, channel);
}

const sendHypeMessageThrottled = _.throttle(sendHypeMessage, HYPE_THROTTLE, {'trailing': false});

/**
 * Detect hype on a given channel, then participate in hype using sendHypeMessage().
 *
 * Uses a channel name as input to load a channel's message queue.
 * If the queue contains enough duplicate messages, we consider that hype.
 *
 * @param channel
 */
function detectHype(channel) {
    let messageCounts = {};

    // Count the occurrences of each unique message in the queue
    for (let message of messageQueues[channel]) {
        if (!Number.isInteger(messageCounts[message]))
            messageCounts[message] = 0;

        messageCounts[message] += 1;

        // If number of occurrences of a message exceeds HYPE_THRESHOLD, then the hype is real
        if (messageCounts[message] >= HYPE_THRESHOLD) {
            messageQueues[channel] = [];
            sendHypeMessageThrottled(channel, message);
            return;
        }
    }
}

/**
 * Occasionally reset all message queues to account for slow chats.
 */
function startDequeueDisposalProcess() {
    setInterval(_ => {
        messageQueues = {};
    }, HYPE_DEQUEUE_TIMER);
}

/**
 * Queue all incoming messages per channel with max queue size to be determined.
 *
 * Ignores bot (moderator) messages.
 *
 * @param channel
 * @param username
 * @param message
 * @param isModerator
 * @param emote
 */
function enqueueChatMessage(channel, username, message, isModerator, emote=null) {
    message = emote ? emote : message;

    // Filter/skip messages that needn't contribute to hype
    if (filterEnqueueMessage(channel, username, message, isModerator))
        return;

    // Record stats about the current user
    recordUserChatStats(channel, username);

    // Ensure the channel queue exists
    if (!Array.isArray(messageQueues[channel]))
        messageQueues[channel] = [];

    // Dequeue the oldest message
    if (messageQueues[channel].length >= HYPE_MAX_QUEUE_LEN)
        messageQueues[channel].shift();

    // Enqueue the new message
    if (message.length >= HYPE_MIN_MSG_LEN && message.length <= HYPE_MAX_MSG_LEN) {
        messageQueues[channel].push(message);
        detectHype(channel)
    }
}

/**
 * Filter a message before enqueue, returning True if message should be filtered out of the queue.
 *
 * @param channel
 * @param username
 * @param message
 * @param isModerator
 * @returns {boolean}
 */
function filterEnqueueMessage(channel, username, message, isModerator) {
    // Moderator or bot sent the message
    if (isModerator || HYPE_USER_IGNORE_LIST.includes(username.toLowerCase()))
        return true;

    // Message is a command
    if (message.charAt(0) === '!')
        return true;

    // Message contains a URL
    if (REGEX_CONTAINS_URI.test(message))
        return true;

    // Message is okay
    return false;
}

/**
 * Record message count stats for current user with Sqlite3.
 *
 * @param channel
 * @param username
 */
function recordUserChatStats(channel, username) {
    db.serialize(() => {
        // Insert new user into chat_user_stats
        let stmt = db.prepare('INSERT INTO chat_user_stats VALUES (?, ?, 0)');
        stmt.run([channel, username], VOID_CALLBACK);
        stmt.finalize();

        // Increment MessageCount for current user
        stmt = db.prepare('UPDATE chat_user_stats SET MessageCount = MessageCount + 1 WHERE userName = ?');
        stmt.run(username, VOID_CALLBACK);
        stmt.finalize();
    });
}

/**
 * Handle any message sent by myself.
 *
 * @param channel
 * @param username
 * @param message
 */
function handleMyMessage(channel, username, message) {
    console.log(`${getFormattedTime()} <${colors.cyanBright(username)}> ${message}`)
}

/**
 * Handle any message sent from any other user.
 *
 * @param channel
 * @param username
 * @param message
 */
function handleOtherMessage(channel, username, message) {
    // Message includes an @ mention
    if (message.toLowerCase().includes('@' + TWITCH_PREFERENCES.credentials.username)) {
        const iterableMessage = message.split(' ').entries();

        let _message = '';

        // Reconstruct the original message with the emboldened username
        for (let [index, word] of iterableMessage) {
            if (word.toLowerCase().includes('@' + TWITCH_PREFERENCES.credentials.username))
                word = colors.whiteBright.bold(word);

            if (index > 0)
                _message += ' ';

            _message += word
        }

        console.log(colors.bgRed(`${getFormattedTime()} <${(username)}> ${_message}`))
    }
}


/*************************
 * TwitchJS Finalization *
 *************************/

// Listen for all public messages from users and bots
chat.on('PRIVMSG', (msg) => {
    let emote;
    if (msg.tags.emotes.length) {
        // Extract emote from indices given by emotes[0]['start'|'end']
        // ex: "emotes":[{"id":"122430","start":0,"end":7}]
        const {start, end} = msg.tags.emotes[0];
        emote = msg.message.substring(start, end + 1);
    }

    msg.channel = msg.channel.replace('#', '');

    const params = [msg.channel, msg.username, msg.message];

    // Listen for specific users or bots
    switch (msg.username) {
        case TWITCH_PREFERENCES.credentials.username:
            handleMyMessage(...params);
            break;
        default:
            handleOtherMessage(...params);
    }

    enqueueChatMessage(...params, msg.isModerator, emote);
});

// Connect to IRC
chat.connect()
    .then(() => {
        // Join channels
        for (const channel of TWITCH_PREFERENCES.channels)
            chat.join(channel);

        // Clear the console and prepare for new output
        console.clear();
        console.log(colors.greenBright('Connection established.\n'));

        startDequeueDisposalProcess();
    });
