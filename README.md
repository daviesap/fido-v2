# Fido Receipt Manager — capture and image review

Fido lets one permitted Google account photograph, upload, or email a receipt image or PDF, select a PDF page when needed, review an automatically suggested crop, rotate it, check image-quality warnings, and privately store both the untouched original and a processed JPEG. Stored receipts can be browsed, compared with their originals, or deleted. It does not include OCR, OpenAI, or FreeAgent yet.

Receipt attachments can also arrive through `receipts@flair.london`. The Gmail, Cloudflare Email Worker, and Firebase Function setup is documented in [docs/EMAIL_INGESTION.md](docs/EMAIL_INGESTION.md).

The app remains a static Next.js PWA hosted on Firebase Hosting. Cropping, rotation, HEIC conversion, conservative image enhancement, and quality analysis happen in the browser. Firestore stores only file and reproducibility metadata; receipt images remain private in Storage and are read with the signed-in Firebase session. Security rules require both the correct UID and a private `fidoOwner` custom claim.

## Receipt workflow

1. Capture or choose a PDF, JPEG, PNG, WebP, HEIC, or HEIF receipt up to 20 MB.
2. For a multi-page PDF, choose the page containing the receipt.
3. Adjust Fido's crop suggestion and rotate the image if necessary.
4. Review the processed image and any blur, exposure, contrast, or resolution warnings.
5. Save the receipt. The original is never modified; a bounded processed JPEG is stored beside it for the later extraction stage.

## 1. Create the Firebase project

1. Create a Firebase project and select the Blaze plan.
2. Enable **Authentication → Google**.
3. Create Firestore in `europe-west4`.
4. Create the default Storage bucket in `europe-west4`.
5. Register a Web app and copy its Firebase configuration.
6. In Google Cloud Billing, add a small budget alert. An alert warns you; it is not a hard spending cap.

Camera/file uploads remain static and browser-side. Email ingestion adds one Firebase HTTPS Function plus a Cloudflare Email Worker; neither stores message bodies.

## 2. Configure locally

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env.local
```

Fill in the `NEXT_PUBLIC_FIREBASE_*` values from the Web app configuration. Then connect the Firebase CLI:

```bash
npx firebase login
npx firebase use --add
```

For browser access to private Storage objects, make sure `cors.example.json` lists every deployed app origin, then apply it to the exact bucket named in your Firebase configuration:

```bash
gcloud storage buckets update gs://YOUR_STORAGE_BUCKET --cors-file=cors.example.json
```

The checked-in example currently includes localhost, Firebase Hosting, and `https://fido.flair.london`.

## 3. Grant your account access

The UI intentionally rejects every Firebase account until its token has the `fidoOwner` claim.

1. Run the app with `npm run dev` and try Google sign-in once. This creates your Firebase Authentication user, then signs it out because the claim is not present yet.
2. Copy that user's UID from **Firebase Console → Authentication → Users**.
3. Authenticate Application Default Credentials and run the local admin script:

```bash
gcloud auth application-default login
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID node scripts/set-owner.mjs YOUR_FIREBASE_UID
```

Sign in again. The script is local administration tooling and is never shipped to the browser or deployed with the app.

## 4. Test and deploy

```bash
npm run lint
npm run typecheck
npm test
npm run emulators
npx firebase deploy
```

`npm run emulators` starts isolated Firestore and Storage emulators and runs the security-rule tests. The deploy command builds the static app and publishes Hosting, Firestore rules/indexes, and Storage rules.

## Optional App Check

Create a reCAPTCHA Enterprise site key, put it in `NEXT_PUBLIC_FIREBASE_APPCHECK_SITE_KEY`, and register it under Firebase App Check. After confirming valid requests in the App Check metrics, enforce it for Firestore and Storage in the console. Local emulator mode does not initialize App Check.

## Stored data

- Original: `receipts/{ownerUid}/{receiptId}/original-{sanitizedOriginalName}`
- Processed image: `receipts/{ownerUid}/{receiptId}/processed-v1.jpg`
- Firestore: `receipts/{receiptId}` with the owner and original metadata plus processed path/size, selected PDF page where applicable, crop percentages, rotation, source/output dimensions, processing version, quality warnings, and timestamps

Older Stage 1 documents with `status: "stored"` remain readable. New reviewed documents use `status: "ready_for_extraction"`, providing a clean trigger point for the future server-side extraction stage.
