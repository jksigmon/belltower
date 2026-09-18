-- Let any logged-in staff member at a school read active compliance form
-- templates and their active share links, so the staff Background Check
-- page can list "Copy Link" options without requiring can_manage_compliance.
-- Mirrors the existing intake_campaigns_staff_read policy used by the
-- staff-facing Form Links (guardian intake) tab.

DROP POLICY IF EXISTS "compliance_form_templates_staff_read" ON "public"."compliance_form_templates";
DROP POLICY IF EXISTS "compliance_form_links_staff_read" ON "public"."compliance_form_links";

CREATE POLICY "compliance_form_templates_staff_read" ON "public"."compliance_form_templates"
FOR SELECT USING (
  ("active" = true) AND (EXISTS ( SELECT 1
    FROM "public"."profiles" "p"
    WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "compliance_form_templates"."school_id") AND ("p"."can_login" = true))))
);

CREATE POLICY "compliance_form_links_staff_read" ON "public"."compliance_form_links"
FOR SELECT USING (
  ("active" = true) AND (EXISTS ( SELECT 1
    FROM "public"."profiles" "p"
    WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "compliance_form_links"."school_id") AND ("p"."can_login" = true))))
);
