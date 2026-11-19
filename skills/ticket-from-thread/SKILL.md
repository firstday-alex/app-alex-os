---
name: ticket-from-thread
description: Turns a Slack thread (every message and every image in it) into one ClickUp ticket for the Site Backlog, with a clear name, a description the team can work from, and every field the thread supports filled. Built only from the thread.
runs_as: agentic
implemented_by: src/send/clickup-ticket.js
invoked_by: Alex using the "Create ClickUp ticket" message shortcut in Slack.
---

# ClickUp ticket from a Slack thread

Alex picked a Slack thread to turn into a ticket in **Site Backlog**. You get **THE THREAD**
(each message numbered, with who said it, when, and the files posted), the images posted
in it, and **THE FIELDS YOU MAY FILL** with the only values each one accepts.

Return the ticket's `name`, its `description` (markdown), `openQuestions`, and `fields`.

## Truth first

**Never invent anything.** Fill a field only when the thread supports it; otherwise set it
to `null` (or `[]`) and say what is missing in `openQuestions`. Use option names exactly as
listed. A person, tag or option not on the list is dropped by the app, so don't guess one.
Numbers, dates, prices, page names and links must appear in the thread or its images.

## Name

- A/B test idea: `<Area> Test: <what changes>` ("PDP Test: Show Price per Gummy Under the Buy Box").
- Anything else: a short imperative summary of the request ("Update 1,000,000 badging to 1,500,000").
- Under 90 characters. A bracket prefix like `[DESIGN]` or `[Bug]` only when it helps.

## Description

Markdown, in this order. Write in plain words, short sentences, the thread's own terms.
The app adds the "Created by Claude" line, the link to the thread and the files, so don't.

1. `## Request` (or `## Idea` for a test): what is being asked, and by whom.
2. `## Problem / Why` (or `## Hypothesis` for a test): why it matters, from the thread.
3. `## Scope / Acceptance criteria` (or `## Variants to consider` for a test): a short list
   of what done looks like. Use what the screenshots show (the page, the element, the copy).
4. `## Success metric`: only for tests or when the thread names one.
5. `## Context`: earlier results, data, decisions or deadlines mentioned. Say who said what
   when it matters ("Tom: the original file would look best").
6. `## Open questions before starting`: every gap (which pages, which products, the copy,
   the date, the owner).

Skip a section that would be empty, except Open questions.

## Fields

- **typeOfRequest**: A/B Test Idea for a test idea; Bug for something broken; New Landing
  Page; Content Update for copy, image or badge changes; Blog Post; Integration/System for
  apps, tracking and data; New Feature Request; Customer Request when it comes from a
  customer; Other.
- **taskCategory**: what kind of work comes first. Design when it needs a design or mockup,
  Development for a build or fix, Merchandising / Authoring for content or product setup in
  Shopify, Research, Testing, Documentation, AB Test Launch for a test.
- **rock** and **tactic**: only when the thread clearly ties to one (names the rock, the
  offer, the funnel, the bundle builder, the quiz). Routine work, fixes and content updates
  are BAU for both. For an A/B test idea: rock AB Testing and tactic AB Testing unless it
  plainly belongs to another rock.
- **experimentType** and **experimentHypothesis**: only for a test. Default type Control vs
  Treatment. Hypothesis is one paragraph: belief, change, expected effect, success metric.
- **testTargeting**: the page, audience or traffic, only if named.
- **testingRequirements**, **deploymentNotes**: only if the thread says (e.g. "don't ship
  during BFCM", "check on mobile").
- **designReferenceUrl**: a Figma or design link copied exactly from the thread. Null if
  there is none (the images are attached anyway).
- **requestor**: the person who asked for it, by full name from the members list. Usually
  the first message's author, unless they are passing on someone else's ask.
- **collaborators**: only people the thread says will work on it.
- **tags**: only tags from the list that plainly fit (bug, cart, checkout, design, idea,
  site-wide…). `outside-request` when the asker is not on the ecom team. Few or none is fine.
- **priority**: only if the thread says how urgent it is (urgent, ASAP, blocking, by a date
  that is close). Otherwise null.
- **dueDate**: only if the thread names a date for it.

## Voice

Alex's team reads this. Plain, specific, no filler, no emoji, no exclamation marks.
