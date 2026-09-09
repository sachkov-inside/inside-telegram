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


**CommunicationTemplate**:
An author's saved message snapshot that can be reused in communication steps and broadcasts.
Editing a template does not change an already published communication.
_Avoid_: Published post, delivered message, Material

**AuthorMode**:
An explicit request by an authorized, linked Telegram person to save the next supported message
as a CommunicationTemplate.
_Avoid_: Marketing subscription, publication, Account permission

## Broadcasts and communication analytics

The communication runtime also owns one-time broadcasts, launch-time audience snapshots, source
entry history, delivery statistics and opaque tracking token/hit ledgers. Physical operations,
paging semantics and safe redirect configuration live in
[communications v1](docs/integrations/communications-v1.md#broadcast-operations-and-analytics).
Platform owns the UI/MCP and redirect consumer; hits identify a delivery link, never the viewer.

**Notification Delivery**:
Адресная доставка определённого Platform Notification по Telegram подтверждённому получателю.
Она имеет собственный результат и не определяет оплату, право доступа или результат другого канала.
_Avoid_: Broadcast, Funnel Step, MembershipEntitlement, прочтение

**CommunityEntitlement**:
Platform's statement that one Account may take part in the Canonical Membership Chat, carried as a
monotonic revision with denied, finite or lifetime access. It is Platform's decision, not our
observation, and it is not a MembershipEvidence.
_Avoid_: MembershipEntitlement, subscription, tariff

**CommunityDesiredState**:
The one CommunityEntitlement per Account this application is currently trying to make true in the
canonical chat, together with what it last observed there.
_Avoid_: Membership, roster entry, cached status

**CommunityEffect**:
One intended change in the canonical chat for one desired state: opening admission, approving a
join, or ensuring absence. It records attempts; it never issues a right.
_Avoid_: Job, task, command

**DispatchPermit**:
Platform's short-lived confirmation that a specific effect attempt is still current. It authorizes
one attempt and is not a reservation of the outcome.
_Avoid_: Lock, token, approval

**AdmissionLink**:
A short-lived bot-created join-request invite bound in our own database to one intended identity
and desired revision. Holding it is not membership.
_Avoid_: Invite, referral link, access link
