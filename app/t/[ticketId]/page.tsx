import { permanentRedirect } from "next/navigation";

/**
 * Retired (0009): ticket runs became machine runs. Old /t/<id> links land
 * on the machines page rather than a 404.
 */
export default function RetiredTicketRun() {
  permanentRedirect("/machines");
}
