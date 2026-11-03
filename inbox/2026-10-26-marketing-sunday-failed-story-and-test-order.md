# Sunday failed story: cause? And test order f2XNsqh4 can be deleted
Status: blocked (2026-11-03: question 1 is answered below; deleting the order and checking the product list need the production database, which this session was not allowed to touch)
From: Marketing, 2026-10-26

## 1. Which story failed on Sunday 25.10.2026 and why?
The daily report "[Magical Story] Tagesbericht Sonntag, 25.10.2026" (hub inbox, Gmail message
1a171cfdf8027bc1) lists one failed story:

- 11:10 CH user demo-d-hsfz6@magicalstory.ch created story "Untitled"
- 11:14 CH "Story generation FAILED: Server restarted during generation", 100 credits auto-refunded

Please tell us: was this a real deploy/restart at that time or an unexpected crash, and is the
restart-during-generation case now handled (resume or clean failure)? One-line answer in this file is enough.

## 2. Failed book order f2XNsqh4 was a test, delete it
Two "[CRITICAL] Book Order Failed After Payment - f2XNsqh4" mails (25.10.2026 23:56 CH, Gmail thread
1a175110015fbd1c): Stripe test-mode session cs_test_...f2XNsqh4, customer "Test Gutschein",
demo-b-hnecf@magicalstory.ch, error "No active products configured. Please add products in admin dashboard."

Owner decision (26.10.2026): this was a test. Delete the failed order; no refund, no customer contact.
Note that the error text says the production product catalogue was empty at that moment; please check
whether that is still the case.

## Answer from MagicalStory, 2026-11-03
1. **It was not a deploy.** Railway lists no production deployment between 24.10 16:43 CH and 25.10 23:10 CH, so the 11:10-11:14 restart
   was the container restarting on its own (a crash or Railway restarting it). The account demo-d-… is one of our own showcase
   test accounts, not a customer. Railway no longer has the logs from that hour, so the exact cause cannot be found now.
   How a restart is handled today: the next start marks every running job failed, refunds its credits in the same database
   transaction, and saves the partial story (server.js:2421-2455). So the story **fails cleanly with a refund. It does not resume.**
2. The order was not deleted yet: deleting it and checking the product list both need the production database, which this
   session was not allowed to touch. Context: on 25.10 test checkouts started on staging were being delivered to production
   until 22:02 CH, and that evening staging's product list was empty until it was copied over. The error may therefore come from
   staging and not mean that production's list was empty; I have not checked this.
