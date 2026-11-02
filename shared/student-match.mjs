/** Never guess between same-name pupils or match beyond the assignment class. */
export function matchStudent(db, assignment, name) {
  if (typeof name !== "string" || !name.trim()) return null;
  const rows = db
    .prepare(
      "SELECT id,name FROM users WHERE school_id=? AND role='student' AND stage=? AND class_name=? AND trim(name)=?",
    )
    .all(
      assignment.school_id,
      assignment.stage,
      assignment.class_name,
      name.trim(),
    );
  return rows.length === 1 ? rows[0] : null;
}
