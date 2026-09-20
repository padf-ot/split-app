import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const splitStates = sqliteTable("split_states", {
  userId: text("user_id").primaryKey(),
  data: text("data").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
