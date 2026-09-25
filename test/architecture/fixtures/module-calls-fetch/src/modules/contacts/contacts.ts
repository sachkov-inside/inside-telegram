export async function contactsCallTelegram(token: string): Promise<unknown> {
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  return response.json();
}
