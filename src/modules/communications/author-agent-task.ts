export function authorAgentTask(
  kind: "broadcasts" | "funnels",
  id: string,
  name: string,
) {
  return (
    `Задача агенту: настроить ${kind === "broadcasts" ? "рассылку" : "воронку"} «${name}».\n\n` +
    `Прочитай черновик через MCP communications_${kind}_read: ${kind === "broadcasts" ? "broadcastId" : "funnelId"}=${id}. ` +
    `Сообщения уже подготовлены в Telegram. Сохрани их текст, entities, fileId и стабильные partId. ` +
    `Настрой кнопки, порядок и ${kind === "broadcasts" ? "общее время отправки; audience={kind:all}" : "задержки шагов"} через communications_${kind}_save. ` +
    `Перед записью прочитай текущую revision, используй expectedRevision и новый operationId; при повторе того же запроса сохраняй operationId. ` +
    `При конфликте перечитай черновик и согласуй изменения, не затирай их. ` +
    `${kind === "funnels" ? "Покажи результат communications_funnels_preview. " : "Покажи итоговый черновик. "}` +
    `Не публикуй и не запускай отправку без моей явной команды.\n\nМоё расписание и пожелания: …`
  );
}
