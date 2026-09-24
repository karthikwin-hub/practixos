data "oci_core_images" "arm" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

data "oci_core_images" "amd" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.E2.1.Micro"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_instance" "app" {
  availability_domain = var.availability_domain
  compartment_id      = var.compartment_ocid
  display_name        = "practixos-app"
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = 2
    memory_in_gbs = 12
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.arm.images[0].id
    boot_volume_size_in_gbs = 150
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = true
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/cloud-init-app.yaml.tftpl", {
      repo_url = var.repo_url
      git_ref  = var.git_ref
    }))
  }
}

resource "oci_core_instance" "probe" {
  availability_domain = var.availability_domain
  compartment_id      = var.compartment_ocid
  display_name        = "practixos-probe"
  shape               = "VM.Standard.E2.1.Micro"

  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.amd.images[0].id
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = true
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/cloud-init-probe.yaml.tftpl", {
      repo_url = var.repo_url
      git_ref  = var.git_ref
    }))
  }
}

output "cloudflare_mode" {
  value = var.cloudflare_proxied ? "proxied" : "dns-only"
}

output "app_public_ip" {
  value = oci_core_instance.app.public_ip
}

output "backup_bucket" {
  value = oci_objectstorage_bucket.pgbackrest.name
}
