---
name: nextjs-fullstack-dev
description: Engineering standards for Next.js 15 App Router, React 19, TypeScript, Tailwind CSS, and Node.js route handlers
---

# Next.js Full-Stack Engineering Skill

<role>
You are a Principal Full-Stack Engineer specializing in Next.js 15 App Router, React 19 Server & Client Components, TypeScript strict mode, and high-throughput Node.js backend route handlers.
</role>

---

## 1. Purpose & Scope

Standardize patterns for frontend UI screens, reusable components, and Node.js REST API route handlers across the LMS:
- **Client/Server Component Separation**: Use `'use client'` strictly where state, event listeners, or browser APIs are required (e.g. modals, share balancer, map view).
- **Node.js Route Handlers**: Implement robust request validation, HTTP-only session verification, database transaction wrapping (`withTransaction`), and standardized JSON error envelopes.
- **Design System & Tailwind**: Strictly follow the corporate Mari Energies palette (emerald/gold/slate tokens) with full dark-mode support and responsive layouts.
- **Accessibility**: ARIA labels, semantic markup, keyboard accessibility (`onKeyDown`, tab order), and visible focus rings.

---

## 2. Activation Criteria

Invoke this skill whenever:
- Creating or editing any file in `src/app/` or `src/components/`.
- Building or updating API route handlers under `src/app/api/`.
- Implementing UI components, data tables, modals, or form workflows.
- Optimizing frontend rendering performance, bundle sizes, or CSS styling.

---

## 3. Prerequisites

1. Active Next.js project dependencies (`package.json`, `tsconfig.json`, `tailwind.config.ts`).
2. Database client abstraction in `src/lib/db.ts`.
3. Domain utilities and formatters in `src/lib/domain.ts`.
4. Authentication helpers in `src/lib/auth.ts`.

---

## 4. Execution Procedure

### Step 1: Component & Page Architecture
- Layouts must wrap content with `Shell` (`import Shell from '@/components/layout/Shell'`).
- Ensure pages gracefully handle loading, empty, and error states.
- Format all currency using `formatPKR(amount)` from `@/lib/domain`.
- Use Lucide icons consistently (`lucide-react`).

### Step 2: Route Handler Architecture (`src/app/api/.../route.ts`)
1. **Authentication Check**:
   ```typescript
   const user = await getCurrentUser();
   if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
   ```
2. **Actor Session Context**:
   Always set the database actor within a transaction for row-level security and audit logging:
   ```typescript
   await withTransaction(async (client) => {
     await client.query('SELECT api.set_actor($1)', [user.id]);
     // Execute parameterized queries
   });
   ```
3. **Idempotency Keys**:
   For mutating operations (releases, advances, case creations), generate or pass idempotency keys to prevent double-submissions.
4. **Error Handling**:
   Catch and format database constraint violations into clear user-friendly messages:
   ```typescript
   return NextResponse.json({ error: error.message || 'Operation failed' }, { status: 400 });
   ```

### Step 3: Frontend Form Validation
- Validate CNIC format (`/^[0-9]{5}-[0-9]{7}-[0-9]{1}$/`).
- Enforce 100% share balancing before case submission (`ShareBalancer.tsx`).
- Prevent submissions for deceased landowners without inheritance documentation.

---

## 5. Expected Deliverables

- Clean, typed `.tsx` and `.ts` files under `src/`.
- Zero TypeScript compiler warnings or errors (`npx tsc --noEmit`).
- Production build compilation (`npm run build`).

---

## 6. Validation Steps

```bash
# Type check all Next.js code
npx tsc --noEmit

# Lint check
npm run lint

# Production build validation
npm run build
```

---

## 7. Failure Handling

- If `NextResponse.json` throws argument count errors, combine error message and codes into a single payload object.
- If a server component imports client-only libraries (e.g. MapLibre or Canvas), use dynamic imports with `{ ssr: false }` or mark with `'use client'`.
