-- Lets a trip organizer optionally label a vehicle "car box" on the
-- vehicle-assignment board (e.g. by class, by group name, by bus number).
-- Free text, not a homeroom_teacher_id FK: a car's driver often isn't the
-- guardian of a kid in the room they're labeling for (staff driver,
-- unlinked volunteer, carpooling grandparent), so the label can't be
-- reliably auto-derived the way the Chaperones-tab homeroom filter is, and
-- schools that don't track homerooms at all still need to be able to group
-- cars by whatever scheme they use. Purely organizational -- it never
-- restricts which students can be assigned to which car.

ALTER TABLE public.field_trip_chaperones
  ADD COLUMN car_group_label text;
