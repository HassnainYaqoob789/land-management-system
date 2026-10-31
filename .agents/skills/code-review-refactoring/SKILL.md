---
name: code-review-refactoring
description: Systematic code quality, refactoring, type safety, linting, performance profiling, and architectural compliance review
---

# Code Review & Refactoring Skill

<role>
You are an Elite Principal Code Reviewer and Software Architect.
Your role is to inspect diffs, audit patterns for technical debt, enforce DRY/KISS/SOLID principles, eliminate dead code, and ensure zero regressions.
</role>

---

## 1. Purpose & Scope

Maintain pristine code quality and architectural integrity across the Next.js, Node.js, and PostgreSQL codebase:
- Verify strict TypeScript types (no unchecked `any`, proper interface definitions).
- Check SQL injection safety (parameterized queries only, no dynamic string interpolation of user input).
- Ensure resource cleanup (pool clients released, transactions committed or rolled back).
- Verify UI component efficiency (memoization, preventing unnecessary re-renders, accessible HTML tags).
- Eliminate duplicate utilities and enforce centralized helpers (`src/lib/domain.ts`, `src/lib/db.ts`, `src/lib/auth.ts`).

---

## 2. Activation Criteria

Invoke this skill whenever:
- Reviewing git diffs before merging or completing a phase (`git diff`).
- Refactoring complex components or backend routes.
- Investigating performance bottlenecks or lint/compiler warnings.
- Performing pre-commit or pre-release code health inspections.

---

## 3. Prerequisites

1. Clean or in-progress git working tree (`git status`, `git diff`).
2. Next.js compiler and TypeScript environment (`npx tsc --noEmit`).
3. ESLint configuration (`npm run lint`).

---

## 4. Execution Procedure

### Step 1: Automated Lint & Type Audit
Run the automated checkers first:
```bash
npx tsc --noEmit
npm run lint
```
Resolve any reported type errors, missing properties, or unused variables.

### Step 2: DML & Query Audit
Inspect all SQL queries:
- Are parameters passed via `$1, $2, ...`?
- Is `withTransaction` used for multi-statement operations?
- Is `api.set_actor($1)` invoked before mutating queries?
- Are column names matching PostgreSQL snake_case schema?

### Step 3: Frontend & UI Quality Checklist
- [ ] No inline styles where Tailwind utilities are sufficient.
- [ ] ARIA labels and roles present on interactive elements (buttons, inputs, modals).
- [ ] Responsive design verified (flex/grid layouts with mobile breakpoints).
- [ ] Correct use of `'use client'` directive.
- [ ] Currency and area numbers properly formatted with thousand separators.

### Step 4: Refactoring Principles
- Prefer simple, readable implementations over premature abstractions.
- Preserve existing public API contracts and response envelopes.
- Delete unused files or obsolete imports.

---

## 5. Expected Deliverables

- Detailed code review comments or refactoring patch.
- Zero TypeScript compiler errors.
- Clean git diff with minimal churn.

---

## 6. Validation Steps

```bash
# Verify type correctness
npx tsc --noEmit

# Verify production build compilation
npm run build

# Review git diff
git diff --stat
```

---

## 7. Failure Handling

If code fails quality gates:
1. Revert anti-patterns immediately.
2. Replace ad-hoc SQL queries with domain helpers.
3. Rerun type checking and test suite before approving completion.
