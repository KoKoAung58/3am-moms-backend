// functions/index.js
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
require("dotenv").config(); // Load from .env file

admin.initializeApp();

exports.uploadToMux = functions.https.onRequest(async (req, res) => {
  try {
    // 1. Check HTTP method
    if (req.method !== "POST") {
      return res.status(405).send("Only POST method is allowed.");
    }

    // 2. Validate request body
    const {videoURL} = req.body;
    if (!videoURL) {
      return res.status(400).send("Missing `videoURL` in request body.");
    }

    // 3. Load Mux credentials
    const muxTokenId = process.env.MUX_TOKEN_ID;
    const muxTokenSecret = process.env.MUX_TOKEN_SECRET;

    if (!muxTokenId || !muxTokenSecret) {
      return res.status(500).send("Missing Mux credentials.");
    }

    // 4. Prepare Mux API request
    const response = await axios.post(
        "https://api.mux.com/video/v1/assets",
        {
          input: videoURL,
          playback_policy: ["public"], // Make playback public
        },
        {
          auth: {
            username: muxTokenId,
            password: muxTokenSecret,
          },
        },
    );

    const playbackId =
        response.data &&
        response.data.data &&
        response.data.data.playback_ids &&
        response.data.data.playback_ids[0] &&
        response.data.data.playback_ids[0].id;

    if (!playbackId) {
      return res.status(500).send("Mux did not return a playback ID.");
    }

    const muxURL = `https://stream.mux.com/${playbackId}.m3u8`;

    // 5. Respond with muxURL
    return res.status(200).json({
      message: "✅ Mux upload successful",
      muxURL,
    });
  } catch (err) {
    console.error("❌ Mux upload error:", err.response?.data || err.message);
    return res.status(500).json({
      message: "Mux upload failed",
      error: err.response?.data || err.message,
    });
  }
});

/**
 * Triggered when a message is created in a chatroom
 * Sends notifications to all users based on their preferences for that chatroom
 */
const CHATROOMS = {
  0: "Newborn Night Shift",
  1: "Questions & Answers",
  2: "No Judgment Zone",
  3: "Milestones",
};

exports.onNewChatMessage = onDocumentCreated(
    "chatrooms/{chatroomId}/messages/{messageId}",
    async (event) => {
      const snap = event.data;
      const context = event;
      const {chatroomId} = context.params;
      const message = snap.data();
      const senderId = message.senderId;
      const text = message.text || "You have a new message";

      const roomTitle = CHATROOMS[chatroomId] || "a chatroom";

      const allUsersSnap = await admin.firestore().collection("users").get();
      const tokensToSend = [];

      for (const userDoc of allUsersSnap.docs) {
        const userId = userDoc.id;
        if (userId === senderId) continue;

        const prefsRef = admin.firestore()
            .collection("users").doc(userId)
            .collection("chatroomPreferences").doc(chatroomId);
        const prefsSnap = await prefsRef.get();

        let level = "all";
        if (prefsSnap.exists) {
          const prefData = prefsSnap.data();
          if (prefData.notificationLevel) {
            level = prefData.notificationLevel;
          }
        }

        if (level === "none") continue;

        if (
          level === "all" ||
          (level === "mentions" && isMentioned(message.text, userDoc.data()))
        ) {
          const token = userDoc.data().fcmToken;
          if (token) {
            tokensToSend.push({token, userName: userDoc.data().firstName});
          }
        }
      }

      const messaging = admin.messaging();
      const payloads = tokensToSend.map(({token, userName}) => ({
        token,
        notification: {
          title: `New message in ${roomTitle}`,
          body: `${message.senderName || "Someone"}: ${truncate(text, 60)}`,
        },
        data: {
          chatroomId,
          type: "chat_message",
        },
      }));

      for (const payload of payloads) {
        try {
          await messaging.send(payload);
        } catch (err) {
          console.error("Failed to send FCM to:", payload.token, err);
        }
      }
    },
);

/**
 * Checks if a given text mentions the user by @firstName
 * @param {string} text - The message text
 * @param {object} userData - The user's data object
 * @return {boolean} Whether the user was mentioned
 */
function isMentioned(text, userData) {
  const firstName = userData?.firstName;
  if (!text || typeof firstName !== "string") return false;
  return text.toLowerCase().includes(`@${firstName.toLowerCase()}`);
}

/**
 * Truncates a string to a maximum length
 * @param {string} str - The original string
 * @param {number} maxLength - Max allowed characters
 * @return {string} The truncated string with ellipsis if needed
 */
function truncate(str, maxLength) {
  return str.length > maxLength ?
    str.substring(0, maxLength - 1) + "…" :
    str;
}

