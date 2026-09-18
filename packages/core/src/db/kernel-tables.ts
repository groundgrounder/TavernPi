// 内核保留表清单（单一事实源）。
//
// 为什么住在 db 层：**表是 db 层建出来的**（schema.ts + migrate.ts 的各版本迁移），
// 清单是对「内核拥有哪些表」这一事实的声明。pack 层（卡包 SQL 静态扫描）与 db 层
// （通用只读查询的表分类）都从这里取——若让 pack 层持有它，db 层就得反向依赖 pack 层。
//
// 卡片命名空间规则见 pack/loader.ts：卡包自建表须以 `<包名>_` 前缀开头，
// 非前缀表被前缀规则拦下；而本清单是**独立的一道闸门**，管的是「前缀恰好覆盖内核表名」的情形
// （如包名 `event` 的前缀 `event_` 覆盖 `event_npcs`）——两道闸门规则不同，不能互相替代。

/**
 * 内核保留表名（卡包 SQL 不得触及；通用只读查询据此区分内核表与卡包表）。
 *
 * **清单必须覆盖内核建出的每一张表**：漏登记的表会被前缀规则悄悄放行——只要包名的命名空间
 * 前缀恰好覆盖该表名。真实旁路：包名 `event` 的前缀 `event_` 覆盖漏登记的 `event_npcs`，
 * 于是 `DELETE FROM event_npcs` 两道闸门都过（已实测，见 pack-loader.test.ts 的用例）。
 *
 * 判据钉在测试里：「内核实际建出的表 ⊆ 本清单」（openStoryDb 后列 sqlite_master 比对），
 * 故新增内核表忘记登记会当场变红，不靠人记得。逆向也查（清单里不该有不存在的表名）。
 */
export const KERNEL_TABLE_WHITELIST: readonly string[] = [
	"clock",
	"time_log",
	"events",
	"event_npcs",
	"locations",
	"location_log",
	"phases",
	"world_state",
	"npcs",
	"npc_traits",
	"npc_memories",
	"npc_relations",
	"turn_log",
	"data_status",
	"directives",
	"schema_migrations",
];
