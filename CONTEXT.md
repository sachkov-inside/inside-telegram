# Inside Telegram

Inside Telegram owns the Telegram-side contact, identity-linking, and Membership-observation
language used by the Sachkov Inside bot application.

## Language

**BotContact**:
A Telegram person who has started the Sachkov Inside bot and can receive bot messages while
Telegram permits delivery. A BotContact may be unlinked and may have no Membership.
_Avoid_: Subscriber, member, lead

**TelegramIdentity**:
The provider-verified Telegram identity from which bot updates originate. It is not an Account,
Membership, username, or profile snapshot.
_Avoid_: Telegram account, username, BotContact

**PlatformLink**:
The historical association between one TelegramIdentity and one opaque Account reference.
It does not grant Membership or content access.
_Avoid_: Login, Membership link, Account merge

**LinkTransaction**:
A short-lived, single-use invitation from an authenticated Account flow to prove and confirm
one PlatformLink through the bot.
_Avoid_: Referral, auth session, permanent link token

**MembershipObservation**:
Telegram's authoritative observation that a linked identity is or is not present in the canonical
closed chat at a specific time.
_Avoid_: Subscription, entitlement, permanent member flag

**MembershipEvidence**:
A finite, normalized statement derived from a MembershipObservation and delivered to Platform.
It contains opaque references rather than Telegram provider data.
_Avoid_: MembershipEntitlement, ChatMember, access token

**Canonical Membership Chat**:
The single closed Telegram chat whose actual roster is the Membership Signal for Inside v1.
_Avoid_: Community directory, Tribute roster, audience segment

**Contactability**:
The current ability to deliver bot messages to a BotContact through Telegram. Blocking the bot
changes Contactability without deleting the BotContact, PlatformLink, or Membership history.
_Avoid_: Consent, Membership, active subscription
