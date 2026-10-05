CREATE TYPE "public"."document_type" AS ENUM('rate_con', 'bol', 'pod', 'lumper_receipt', 'tif', 'fuel_receipt', 'damage_photo', 'driver_signature', 'w9', 'insurance_cert', 'exemption');--> statement-breakpoint
CREATE TYPE "public"."driver_status" AS ENUM('active', 'inactive', 'on_leave');--> statement-breakpoint
CREATE TYPE "public"."eld_provider" AS ENUM('samsara', 'motive', 'simulator', 'manual');--> statement-breakpoint
CREATE TYPE "public"."hos_status" AS ENUM('off_duty', 'sleeper', 'available', 'driving', 'on_duty');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void');--> statement-breakpoint
CREATE TYPE "public"."load_status" AS ENUM('booked', 'dispatched', 'in-transit', 'delivered', 'paid');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('push', 'sms', 'email', 'in_app');--> statement-breakpoint
CREATE TYPE "public"."pay_type" AS ENUM('percentage', 'flat_per_mile', 'flat_per_load', 'salary');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('free', 'starter', 'business');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('driver', 'dispatcher', 'owner', 'admin');--> statement-breakpoint
CREATE TYPE "public"."settlement_status" AS ENUM('draft', 'approved', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."stop_status" AS ENUM('pending', 'arrived', 'completed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."stop_type" AS ENUM('pickup', 'delivery', 'waypoint');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('none', 'trialing', 'active', 'past_due', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."trailer_type" AS ENUM('dry_van', 'reefer', 'flatbed', 'step_deck', 'tanker', 'box_truck', 'power_only');--> statement-breakpoint
CREATE TYPE "public"."truck_status" AS ENUM('available', 'loaded', 'empty', 'maintenance');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"name" varchar(120) NOT NULL,
	"keyHash" varchar(64) NOT NULL,
	"prefix" varchar(12) NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"mcNumber" varchar(20),
	"dotNumber" varchar(20),
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"subscription_status" "subscription_status" DEFAULT 'none' NOT NULL,
	"paymentCustomerId" varchar(120),
	"paymentSubscriptionId" varchar(120),
	"timezone" varchar(64) DEFAULT 'America/Chicago' NOT NULL,
	"homeTerminal" varchar(200),
	"address" text,
	"billingEmail" varchar(320),
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"loadId" varchar(40) NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"type" "document_type" NOT NULL,
	"fileName" varchar(300) NOT NULL,
	"storage_key" text NOT NULL,
	"mimeType" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploadedBy" varchar(40) NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_at" timestamp with time zone,
	"lat" real,
	"lng" real,
	"signatureName" varchar(200),
	"signature_data_url" text,
	"page_count" integer,
	"status" varchar(20) DEFAULT 'uploaded' NOT NULL,
	"reject_reason" text
);
--> statement-breakpoint
CREATE TABLE "driver_deductions" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"driverId" varchar(40) NOT NULL,
	"amount_cents" integer NOT NULL,
	"category" varchar(30) NOT NULL,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"settledOn" varchar(40)
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"userId" varchar(40),
	"name" varchar(200) NOT NULL,
	"phone" varchar(32),
	"email" varchar(320),
	"home_base" jsonb,
	"homeTerminal" varchar(200),
	"licenseNumber" varchar(40),
	"licenseState" varchar(2),
	"license_expires_at" timestamp with time zone,
	"hazmat_endorsed" boolean DEFAULT false NOT NULL,
	"tanker_endorsed" boolean DEFAULT false NOT NULL,
	"team_drivers" boolean DEFAULT false NOT NULL,
	"status" "driver_status" DEFAULT 'active' NOT NULL,
	"hire_date" timestamp with time zone,
	"pay_type" "pay_type" DEFAULT 'flat_per_mile' NOT NULL,
	"pay_rate_bps" integer,
	"pay_per_mile_cents" integer,
	"max_daily_drive_hours" real,
	"preferred_lanes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"do_not_assign" boolean DEFAULT false NOT NULL,
	"avatar_url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"type" varchar(40) NOT NULL,
	"entityType" varchar(20) NOT NULL,
	"entityId" varchar(40) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actorId" varchar(40),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"offline" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fuel_entries" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"truckId" varchar(40) NOT NULL,
	"driverId" varchar(40),
	"loadId" varchar(40),
	"gallons" numeric(8, 2) NOT NULL,
	"price_cents_per_gallon" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"odometer_miles" integer,
	"lat" real,
	"lng" real,
	"jurisdictionCode" varchar(4),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"receipt_storage_key" text,
	"cardLast4" varchar(4),
	"is_prepaid" boolean DEFAULT false NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "gps_pings" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"truckId" varchar(40) NOT NULL,
	"lat" real NOT NULL,
	"lng" real NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"accuracy_m" real,
	"heading_deg" real,
	"speed_mph" real,
	"source" varchar(20) DEFAULT 'gps' NOT NULL,
	"offline" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ifta_reports" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"periodLabel" varchar(20) NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"report" jsonb NOT NULL,
	"net_tax_due_cents" integer NOT NULL,
	"filed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"invoiceId" varchar(40) NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"loadId" varchar(40),
	"description" varchar(400) NOT NULL,
	"kind" varchar(40) NOT NULL,
	"miles" integer DEFAULT 0 NOT NULL,
	"rate_cents" integer,
	"amount_cents" integer NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"number" varchar(40) NOT NULL,
	"brokerName" varchar(200) NOT NULL,
	"brokerAccountRef" varchar(120),
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"amount_paid_cents" integer DEFAULT 0 NOT NULL,
	"balance_cents" integer NOT NULL,
	"terms_days" integer DEFAULT 30 NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"quick_pay_bps" integer,
	"quick_pay_window_days" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "load_stops" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"loadId" varchar(40) NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"type" "stop_type" NOT NULL,
	"sequence" integer NOT NULL,
	"facilityName" varchar(300) NOT NULL,
	"address" varchar(400) NOT NULL,
	"city" varchar(120) NOT NULL,
	"state" varchar(2) NOT NULL,
	"postalCode" varchar(12),
	"lat" real,
	"lng" real,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"appointment_required" boolean DEFAULT false NOT NULL,
	"appointmentRef" varchar(120),
	"contactName" varchar(200),
	"contactPhone" varchar(32),
	"status" "stop_status" DEFAULT 'pending' NOT NULL,
	"arrived_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loads" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"reference" varchar(120),
	"broker" varchar(200) NOT NULL,
	"origin" varchar(300) NOT NULL,
	"destination" varchar(300) NOT NULL,
	"rate" integer NOT NULL,
	"miles" integer NOT NULL,
	"status" "load_status" DEFAULT 'booked' NOT NULL,
	"commodity" varchar(200),
	"weight_lbs" integer,
	"equipment" "trailer_type",
	"pickup_date" timestamp with time zone,
	"delivery_date" timestamp with time zone,
	"pickup_window_start" timestamp with time zone,
	"pickup_window_end" timestamp with time zone,
	"delivery_window_start" timestamp with time zone,
	"delivery_window_end" timestamp with time zone,
	"booked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"assignedTruckId" varchar(40),
	"assignedDriverId" varchar(40),
	"driver_pay_cents" integer,
	"linehaul_cents" integer,
	"fuel_surcharge_cents" integer,
	"accessorial_cents" integer,
	"rateType" varchar(20),
	"quick_pay_eligible" boolean DEFAULT true NOT NULL,
	"source" varchar(20) DEFAULT 'manual' NOT NULL,
	"notes" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"proof_of_delivery_missing" boolean DEFAULT false NOT NULL,
	"invoicedOn" varchar(40),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"userId" varchar(40),
	"driverId" varchar(40),
	"kind" varchar(40) NOT NULL,
	"priority" varchar(20) DEFAULT 'normal' NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"url" varchar(300),
	"channel" "notification_channel" DEFAULT 'in_app' NOT NULL,
	"entityType" varchar(20),
	"entityId" varchar(40),
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"providerMessageId" varchar(120),
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"invoiceId" varchar(40) NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"amount_cents" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"method" varchar(20) NOT NULL,
	"reference" varchar(120),
	"note" text,
	"fee_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlement_lines" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"settlementId" varchar(40) NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"sequence" integer NOT NULL,
	"kind" varchar(30) NOT NULL,
	"description" varchar(400) NOT NULL,
	"loadId" varchar(40),
	"miles" integer DEFAULT 0 NOT NULL,
	"rate_cents" integer,
	"amount_cents" integer NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"driverId" varchar(40) NOT NULL,
	"driverName" varchar(200) NOT NULL,
	"weekKey" varchar(10) NOT NULL,
	"week_start" timestamp with time zone NOT NULL,
	"week_end" timestamp with time zone NOT NULL,
	"status" "settlement_status" DEFAULT 'draft' NOT NULL,
	"gross_revenue_cents" integer DEFAULT 0 NOT NULL,
	"load_pay_cents" integer DEFAULT 0 NOT NULL,
	"deadhead_pay_cents" integer DEFAULT 0 NOT NULL,
	"per_diem_cents" integer DEFAULT 0 NOT NULL,
	"reimbursements_cents" integer DEFAULT 0 NOT NULL,
	"bonus_cents" integer DEFAULT 0 NOT NULL,
	"advances_cents" integer DEFAULT 0 NOT NULL,
	"deductions_cents" integer DEFAULT 0 NOT NULL,
	"gross_cents" integer DEFAULT 0 NOT NULL,
	"net_cents" integer DEFAULT 0 NOT NULL,
	"total_loaded_miles" integer DEFAULT 0 NOT NULL,
	"total_empty_miles" integer DEFAULT 0 NOT NULL,
	"loads_completed" integer DEFAULT 0 NOT NULL,
	"driverSignatureName" varchar(200),
	"driver_signed_at" timestamp with time zone,
	"approvedBy" varchar(40),
	"approved_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"paymentMethod" varchar(40),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "advances" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"driverId" varchar(40) NOT NULL,
	"amount_cents" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"settledOn" varchar(40)
);
--> statement-breakpoint
CREATE TABLE "trucks" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"unit" varchar(40) NOT NULL,
	"vin" varchar(20),
	"plate" varchar(20),
	"make" varchar(60),
	"model" varchar(60),
	"year" integer,
	"trailer_type" "trailer_type" DEFAULT 'dry_van' NOT NULL,
	"status" "truck_status" DEFAULT 'available' NOT NULL,
	"max_weight_lbs" integer,
	"homeTerminal" varchar(200),
	"driverId" varchar(40),
	"currentLoadId" varchar(40),
	"currentDriverName" varchar(200),
	"lat" real DEFAULT 0 NOT NULL,
	"lng" real DEFAULT 0 NOT NULL,
	"last_known_at" timestamp with time zone,
	"odometer" integer,
	"hos_status" "hos_status",
	"eld_provider" "eld_provider" DEFAULT 'simulator' NOT NULL,
	"eldDeviceId" varchar(120),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"companyId" varchar(40) NOT NULL,
	"email" varchar(320) NOT NULL,
	"name" varchar(200) NOT NULL,
	"role" "role" DEFAULT 'dispatcher' NOT NULL,
	"password_hash" text,
	"driverId" varchar(40),
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"pushToken" varchar(200),
	"phone" varchar(32),
	"timezone" varchar(64) DEFAULT 'America/Chicago' NOT NULL,
	"quiet_hours_start" integer,
	"quiet_hours_end" integer,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_idx" ON "api_keys" USING btree ("keyHash");--> statement-breakpoint
CREATE INDEX "companies_billing_email_idx" ON "companies" USING btree ("billingEmail");--> statement-breakpoint
CREATE INDEX "documents_load_idx" ON "documents" USING btree ("loadId");--> statement-breakpoint
CREATE INDEX "documents_company_idx" ON "documents" USING btree ("companyId","type");--> statement-breakpoint
CREATE INDEX "driver_deductions_driver_idx" ON "driver_deductions" USING btree ("driverId","at");--> statement-breakpoint
CREATE INDEX "drivers_company_idx" ON "drivers" USING btree ("companyId");--> statement-breakpoint
CREATE INDEX "drivers_user_idx" ON "drivers" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "drivers_name_idx" ON "drivers" USING btree ("companyId","name");--> statement-breakpoint
CREATE INDEX "events_entity_idx" ON "events" USING btree ("entityId","occurred_at");--> statement-breakpoint
CREATE INDEX "events_company_idx" ON "events" USING btree ("companyId","occurred_at");--> statement-breakpoint
CREATE INDEX "fuel_entries_truck_idx" ON "fuel_entries" USING btree ("truckId","at");--> statement-breakpoint
CREATE INDEX "fuel_entries_company_idx" ON "fuel_entries" USING btree ("companyId","at");--> statement-breakpoint
CREATE INDEX "fuel_entries_jurisdiction_idx" ON "fuel_entries" USING btree ("companyId","jurisdictionCode");--> statement-breakpoint
CREATE INDEX "gps_pings_truck_time_idx" ON "gps_pings" USING btree ("truckId","at");--> statement-breakpoint
CREATE INDEX "gps_pings_company_time_idx" ON "gps_pings" USING btree ("companyId","at");--> statement-breakpoint
CREATE UNIQUE INDEX "ifta_reports_period_idx" ON "ifta_reports" USING btree ("companyId","periodLabel");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("invoiceId","sequence");--> statement-breakpoint
CREATE INDEX "invoice_lines_load_idx" ON "invoice_lines" USING btree ("loadId");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_idx" ON "invoices" USING btree ("number");--> statement-breakpoint
CREATE INDEX "invoices_company_idx" ON "invoices" USING btree ("companyId");--> statement-breakpoint
CREATE INDEX "invoices_broker_idx" ON "invoices" USING btree ("companyId","brokerName");--> statement-breakpoint
CREATE INDEX "invoices_due_idx" ON "invoices" USING btree ("companyId","due_at");--> statement-breakpoint
CREATE INDEX "load_stops_load_idx" ON "load_stops" USING btree ("loadId","sequence");--> statement-breakpoint
CREATE INDEX "load_stops_company_idx" ON "load_stops" USING btree ("companyId");--> statement-breakpoint
CREATE INDEX "loads_company_idx" ON "loads" USING btree ("companyId");--> statement-breakpoint
CREATE INDEX "loads_company_status_idx" ON "loads" USING btree ("companyId","status");--> statement-breakpoint
CREATE INDEX "loads_truck_idx" ON "loads" USING btree ("assignedTruckId");--> statement-breakpoint
CREATE INDEX "loads_driver_idx" ON "loads" USING btree ("assignedDriverId");--> statement-breakpoint
CREATE INDEX "loads_broker_idx" ON "loads" USING btree ("companyId","broker");--> statement-breakpoint
CREATE INDEX "loads_pickup_idx" ON "loads" USING btree ("companyId","pickup_date");--> statement-breakpoint
CREATE INDEX "loads_invoiced_idx" ON "loads" USING btree ("invoicedOn");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("userId","created_at");--> statement-breakpoint
CREATE INDEX "notifications_company_idx" ON "notifications" USING btree ("companyId","created_at");--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "payments" USING btree ("invoiceId");--> statement-breakpoint
CREATE INDEX "payments_company_idx" ON "payments" USING btree ("companyId","at");--> statement-breakpoint
CREATE INDEX "settlement_lines_settlement_idx" ON "settlement_lines" USING btree ("settlementId","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_driver_week_idx" ON "settlements" USING btree ("driverId","weekKey");--> statement-breakpoint
CREATE INDEX "settlements_company_idx" ON "settlements" USING btree ("companyId","weekKey");--> statement-breakpoint
CREATE INDEX "advances_driver_idx" ON "advances" USING btree ("driverId","at");--> statement-breakpoint
CREATE INDEX "trucks_company_idx" ON "trucks" USING btree ("companyId");--> statement-breakpoint
CREATE UNIQUE INDEX "trucks_company_unit_idx" ON "trucks" USING btree ("companyId","unit");--> statement-breakpoint
CREATE INDEX "trucks_company_status_idx" ON "trucks" USING btree ("companyId","status");--> statement-breakpoint
CREATE INDEX "trucks_driver_idx" ON "trucks" USING btree ("driverId");--> statement-breakpoint
CREATE INDEX "trucks_location_idx" ON "trucks" USING btree ("companyId","lat","lng");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_company_idx" ON "users" USING btree ("companyId");