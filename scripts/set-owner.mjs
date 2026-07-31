import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const uid = process.argv[2];

if (!uid) {
  console.error("Usage: GOOGLE_CLOUD_PROJECT=<project-id> node scripts/set-owner.mjs <firebase-uid>");
  process.exit(1);
}

initializeApp({ credential: applicationDefault() });

const auth = getAuth();
const user = await auth.getUser(uid);
const existingClaims = user.customClaims ?? {};

await auth.setCustomUserClaims(uid, {
  ...existingClaims,
  fidoOwner: true,
});

console.log(`Granted the fidoOwner claim to ${user.email ?? uid}.`);
console.log("Sign out and back in so Firebase issues a fresh ID token.");
