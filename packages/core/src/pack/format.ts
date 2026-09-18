// 卡包文本与标识符格式化（loader / matcher / seed 共用）。
//
// 存在的理由：ref 形式 `[包名:]type:id`（见 types.ts 的 CollectionEntry.refs）原先在
// loader 与 matcher 里各写一份字面量拼接，`truncateChars` 也各留了一份逐字相同的实现——
// 形式一旦调整就得靠人眼同步多处。这里收成单一来源。

/** 包内标识 `type:id`（不含包名；跨包索引的键）。 */
export function typeIdRef(type: string, id: string): string {
	return `${type}:${id}`;
}

/** 全局标识 `包名:type:id`（注入 ident / 跨包引用用的完整形式）。 */
export function entryIdent(pack: string, type: string, id: string): string {
	return `${pack}:${type}:${id}`;
}

/** 按码点截断（中文友好，计数「字」而非 UTF-16 码元）。 */
export function truncateChars(text: string, max: number): string {
	const chars = [...text];
	return chars.length > max ? chars.slice(0, max).join("") : text;
}
