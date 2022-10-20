/*******************
 * Library Imports *
 *******************/

import colors from 'chalk'
import dotenv from 'dotenv'
import TwitchJs from 'twitch-js'
import _ from 'lodash'
dotenv.config()

/*****************
 * Configuration *
 *****************/

// Toggle ability to send real messages to Twitch channels.
const DRY_RUN = false;

// Configure hype parameters
const MIN_MSG_LEN = 1,
    MAX_MSG_LEN = 200,
    MAX_QUEUE_LEN = 7,
    HYPE_THRESHOLD = 2,
    HYPE_THROTTLE = 10000

const preferences = {
    channels: [
        'squishy_life',
        'carteldel',
	'northernlion'
    ],
    credentials: {
        username: `${process.env.TWITCH_USERNAME}`,
        token: `${process.env.TWITCH_PASSWORD}`
    },
    delays: {
        botResponseDefault: 0
    }
};

let messageQueues = {};

/******************
 * TwitchJS Setup *
 ******************/

// Create an instance of TwitchJS.
const chat = new TwitchJs.Chat({
    username: preferences.credentials.username,
    token: preferences.credentials.token,
    log: { level: 'error' }
});

// Extends TwitchJS functionality.
chat.say = limiter((msg, channel) => {
    if (DRY_RUN) {
        console.log(`${colors.gray(getFormattedTime())} ${msg} -- (DRY RUN ENABLED)`);
        return;
    }

    chat.send(`PRIVMSG #${channel} :${msg}`)
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
    `[${new Date().toLocaleString('en-US', { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true })}]`

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

    const caller = function() {
        if (calls.length && !isCalled) {
            isCalled = true;
            calls.shift().call();
            setTimeout(function() {
                isCalled = false;
                caller()
            }, wait)
        }
    };

    return function() {
        calls.push(fn.bind(this, ...arguments));
        caller()
    }
}


/******************************
 * Message Handling Functions *
 ******************************/

function beginHype(channel, message) {
    console.log(`${colors.gray(getFormattedTime())} '${channel}': "${message}".`);
    chat.say(message, channel);
}
let hype = _.throttle(beginHype, HYPE_THROTTLE, {'trailing': false})

/**
 * Detect hype on a given channel.
 *
 * @param channel
 */
function detectHype(channel) {
    let hyped = false,
        messageCounts = {},
        hypeMessage = '';

    // Count the occurrences of each unique message in the queue
    for (let message of messageQueues[channel]) {
        if (!Number.isInteger(messageCounts[message]))
            messageCounts[message] = 0;

        messageCounts[message] += 1;

        // If number of occurrences of a message exceeds HYPE_THRESHOLD, then the hype is real
        if (messageCounts[message] >= HYPE_THRESHOLD) {
            hypeMessage = message;
            hyped = true;
            break
        }
    }

    if (hyped) {
        // Clear the channel's queue
        messageQueues[channel] = [];

        // beginHype(channel, hypeMessage);
        hype(channel, hypeMessage);
    }
}

/**
 * Queue all incoming messages per channel with max queue size to be determined.
 *
 * @param channel
 * @param username
 * @param message
 */
function enqueueChatMessage(channel, username, message) {
    // Ensure the channel queue exists
    if (!Array.isArray(messageQueues[channel]))
        messageQueues[channel] = [];

    // Dequeue the oldest message
    if (messageQueues[channel].length >= MAX_QUEUE_LEN)
        messageQueues[channel].shift();

    // Enqueue the new message
    if (message.length >= MIN_MSG_LEN && message.length <= MAX_MSG_LEN) {
        messageQueues[channel].push(message);
        detectHype(channel)
    }
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
    if (message.toLowerCase().includes('@' + preferences.credentials.username)) {
        const iterableMessage = message.split(' ').entries();

        let _message = '';

        // Reconstruct the original message with the emboldened username
        for (let [index, word] of iterableMessage) {
            if (word.toLowerCase().includes('@' + preferences.credentials.username))
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
    msg.channel = msg.channel.replace('#', '');

    const params = [msg.channel, msg.username, msg.message];

    // Listen for specific users or bots
    switch (msg.username) {
        case preferences.credentials.username:
            handleMyMessage(...params);
            break;
        default:
            handleOtherMessage(...params);
    }

    enqueueChatMessage(...params);
});

// Connect to IRC
chat.connect()
    .then(() => {
        // Join channels
        for (const channel of preferences.channels)
            chat.join(channel);

        // Clear the console and prepare for new output
        console.clear();
        console.log(colors.greenBright('Connection established.\n'))
    });

