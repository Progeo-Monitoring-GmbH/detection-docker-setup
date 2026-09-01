import json
import re

from django.core.management.base import CommandError

from progeo.helper.airtable import AirtableHelper
from progeo.helper.basics import dlog, elog, ilog, okaylog

from progeo.management.commands._base import BaseCommand
from progeo.v1.models import ProgeoLocation





def is_broken_address(address):
    """
    Parse and validate address structure, identifying address components.
    Handles flexible component ordering (company name may be first, etc.).
    
    Returns dict with:
    - is_broken: bool
    - issues: list of validation issues
    - parts: dict with identified components (street, postal_code, city, company, etc.)
    """
    if not address or not isinstance(address, str):
        return {
            'is_broken': True,
            'issues': ['Empty or invalid address'],
            'parts': {}
        }
    
    issues = []
    address_clean = address.strip()
    
    # Split by newlines and commas to get components
    components = re.split(r'[,\n]', address_clean)
    components = [c.strip() for c in components if c.strip()]
    
    parts = {
        'company': None,
        'street': None,
        'postal_code': None,
        'city': None,
        'other': []
    }
    
    if len(components) < 2:
        issues.append(f'Too few components: {len(components)} (expected at least 2)')
    
    # Identify postal code (German format: 5 digits) and extract city
    postal_code_pattern = r'\b(\d{5})\b'
    city_in_postal_component = None
    
    for component in components:
        postal_match = re.search(postal_code_pattern, component)
        if postal_match:
            parts['postal_code'] = postal_match.group(1)
            # Extract city from same component if present
            city_part = re.sub(postal_code_pattern, '', component).strip()
            if city_part:
                city_in_postal_component = city_part
    
    if not parts['postal_code']:
        issues.append('Missing postal code (5-digit format)')
    
    # Identify street (contains numbers or street keywords)
    street_pattern = r'\d+|straße|str\.|weg|platz|allee|ring|damm|haus'
    
    for component in components:
        if re.search(postal_code_pattern, component):
            # Skip postal code component, already processed
            continue
        
        if re.search(street_pattern, component.lower()):
            if not parts['street']:
                parts['street'] = component
            else:
                parts['other'].append(component)
        else:
            # Could be company, city, or other info
            # If it's not a street and we already have a street, it might be company or city
            if parts['street'] and not city_in_postal_component and not parts['city']:
                # This could be the city
                parts['city'] = component
            elif not parts['company'] and not parts['street']:
                # This could be company name (before street address)
                parts['company'] = component
            else:
                parts['other'].append(component)
    
    # Use city from postal component if extracted
    if city_in_postal_component and not parts['city']:
        parts['city'] = city_in_postal_component
    
    # Validate we have at least street and postal code
    if not parts['street']:
        issues.append('Missing street address')
    if not parts['city']:
        issues.append('Missing city')
    
    # Clean up other list
    parts['other'] = [x for x in parts['other'] if x]
    
    return {
        'is_broken': len(issues) > 0,
        'issues': issues,
        'parts': parts
    }


def handle_new_project(record, project_id):
    # Implement the logic to handle a new project here
    pass

class Command(BaseCommand):
    help = (
        "Import projects from the Airtable projects table and identify new and existing projects. "
        "Also validates project addresses."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--list-tables",
            action="store_true",
            help="List all tables of the base (id + name) and exit.",
        )


    def handle(self, *args, **options):
        
        records = json.loads(open("airtable_projects_min.json", "r", encoding="utf-8").read())
        project_ids = ProgeoLocation.objects.values_list('project_id', flat=True)
        new_projects_count = 0
        existing_projects_count = 0
        status_count_map = {}
        project_type_count_map = {}
        has_address = 0
        addresses = []

        #TODO fields: Projektnummer,Objektname,Projekttyp,Status,Baustellenadresse,Portalstatus
        for record in records:
            _fields = record.get('fields', {})
            project_id = _fields.get('Projektnummer')
            if project_id:
                if project_id in project_ids:
                    existing_projects_count += 1
                else:
                    okaylog(f"Found new project with ID: {project_id}")
                    handle_new_project(record, project_id)
                    new_projects_count += 1

                status = _fields.get('Status')
                if status:
                    status_count_map[status] = status_count_map.get(status, 0) + 1
                project_type = _fields.get('Projekttyp')
                if project_type:
                    project_type_count_map[project_type] = project_type_count_map.get(project_type, 0) + 1

                addresse = _fields.get('Baustellenadresse')
                if addresse:
                    has_address += 1
                    addresses.append(addresse)
        print()
        ilog(f"Total new projects found: {new_projects_count}")
        ilog(f"Total existing projects found: {existing_projects_count}")
        print()

        dlog("Status count map:")
        for status, count in status_count_map.items():
            dlog(f"  {status}: {count}")
        print()

        dlog("Project type count map:")
        for project_type, count in project_type_count_map.items():
            dlog(f"  {project_type}: {count}")
        print()
        ilog(f"Total projects with address: {has_address}/{new_projects_count + existing_projects_count}")
        ilog("Addresses:")
        broken_addresses = []
        for address in addresses:
            validation = is_broken_address(address)
            parts = validation['parts']
            parts_str = " | ".join(filter(None, [
                parts.get('company'),
                parts.get('street'),
                f"{parts.get('postal_code')} {parts.get('city')}".strip()
            ]))
            
            if validation['is_broken']:
                broken_addresses.append({'address': address, 'issues': validation['issues'], 'parts': parts})
                ilog(f"  [BROKEN] {address}")
                for issue in validation['issues']:
                    elog(f"    - {issue}")
            else:
                okaylog(f"  ✓ {parts_str}")
        
        print()
        okaylog(f"Total broken addresses: {len(broken_addresses)}")
        if broken_addresses:
            okaylog("Broken addresses details:")
            for item in broken_addresses:
                dlog(f"  Address: {item['address']}")
                parts = item['parts']
                if parts.get('company'):
                    dlog(f"    Company: {parts['company']}")
                if parts.get('street'):
                    dlog(f"    Street: {parts['street']}")
                if parts.get('postal_code'):
                    dlog(f"    Postal: {parts['postal_code']}")
                if parts.get('city'):
                    dlog(f"    City: {parts['city']}")
                if parts.get('other'):
                    dlog(f"    Other: {', '.join(parts['other'])}")
                for issue in item['issues']:
                    elog(f"    Issue: {issue}")
