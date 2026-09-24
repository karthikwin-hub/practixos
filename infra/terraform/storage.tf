data "oci_objectstorage_namespace" "ns" {
  compartment_id = var.compartment_ocid
}

# Geo-redundant encrypted nightly dumps go to Azure Blob in Central India
# (centralindia). That copy is credits, then paid. It is not the production
# database, which stays on this OCI bucket in ap-mumbai-1.
resource "oci_objectstorage_bucket" "pgbackrest" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.ns.namespace
  name           = "practixos-pgbackrest"
  access_type    = "NoPublicAccess"
}
