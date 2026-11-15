# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who are learning several things at once and cannot tell, before an exam or a deadline, which of them are quietly fading.

- **Primary:** university students taking several courses in the same term, and self-directed learners studying a subject over weeks or months. Their situation: they have notes (typed, PDF, or photographed handwriting) and a feeling that some of it has slipped, but no way to see which concepts, or how long they have.
- **Their job:** decide what to review next, and prove to themselves that they understood something rather than just recognised it.
- **Secondary (confirmed):** reviewers and evaluators who open the landing page and want to see technical depth as well as a clear pitch. The page does not address them by name.

## Product Purpose

Synapse turns a learner's own notes into a per-course concept map and predicts when each concept will be forgotten, before it is. Success is a learner who reviews the right concept at the right moment and knows which concepts they understood rather than only remembered.

## Positioning

Three mechanisms, all confirmed as the differentiator, that a generic flashcard or note app could not truthfully copy:

1. **Forgetting is predicted per concept.** Each concept has a retention value that decays along a forgetting curve (R = e^(-t/S)) fitted to that learner's own review history, so the map shows what is about to fade, not only what is already old.
2. **Remembering and understanding are separate signals.** Retention (colour) comes from time and reviews; confidence (outline) comes from quizzes. A concept can be fresh but not understood, or understood but fading, and the map shows the difference.
3. **Courses connect.** Related concepts across a learner's courses are linked on one shared map, so what is learned in one course strengthens another.

## Operating Context

- The learner uploads notes for a course (PDF, PNG, JPG, TXT or MD, up to five files). Handwritten notes and photos are read by OCR.
- The map is a hub-and-spoke graph: each course is a neutral hub, its concepts branch from it, and sub-concepts cluster around concepts.
- Learners can tag a course with an optional semester label and filter the map by it.
- Quizzes are multiple choice. With no quiz from class: 10 questions of mixed difficulty (easy 1 point, medium 2, hard 3). After uploading a typed quiz export from their class: 3 to 5 questions ordered easy to hard (question k is worth k points).
- A weak quiz result lowers a concept's retention immediately so it shows as needing review; "Got it" restores it and slows the next fade.

## Capabilities and Constraints

- Web app with accounts; light and dark mode both required.
- Retention is shown by node colour on a continuous green-to-red scale; node size shows how connected a concept is; the outline style shows quiz confidence (not assessed, low, medium, high).
- Clicking any concept opens a short explanation; a Guide page lists every concept with a full explanation and study resources, weakest first.
- Course-level industry skills are generated per course.
- Digital quiz upload accepts only typed exports with visible per-question points. Handwritten or photographed quizzes are explicitly not supported yet and the interface says so.
- Terms: concept, course hub, retention, confidence, review, semester.
- Not built and not to be claimed: email or push reminders. There are no subscribers to the alert channel yet.

## Brand Commitments

- Name: Synapse.
- The page must state specifically what the product does: it predicts what you are about to forget, before you forget it.
- The landing page stays generic: no hackathon, sponsor, technology-vendor or university references, and no real course codes. (Confirmed by the owner.)
- Light and dark mode must both work, not one hardcoded.

## Evidence on Hand

- A working product with real screens: the concept graph, the node popup, the quiz, the Guide, the upload form. Seeded demo data is fictional; screenshots may use generic course names.
- Absent, and must not be fabricated: testimonials, customer or user counts, benchmarks, retention-improvement percentages, press, logos, awards.

## Product Principles

1. Say what it does in concrete terms (what is predicted, from what, and what you do about it) rather than naming a category.
2. Show the real product. The concept graph is the proof; never substitute stock imagery or decorative illustration.
3. Keep the two signals visibly separate: memory is not understanding.
4. Claim only what the build does. If it is not built or measured, it is not on the page.
5. Respect the learner's attention: one idea per section, specific numbers instead of adjectives.
